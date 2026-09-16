import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ArchiveStore, THREAD_STATUSES } from './archive.js';
import { SyncScheduler } from './sync.js';

const PORT = Number(process.env.PORT || 8787);
const AUTH_TOKEN = process.env.RENAMER_TOKEN || "change-me";
// The sidebar-scroll-based commands (rename/move-to-project for a background
// thread) have their own client-side budget of up to ~80 * 300ms = 24s just to
// locate the thread in a virtualized list, before any menu interaction. This
// must stay comfortably above that worst case or the server times out a
// command that was still legitimately in progress.
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS || 40000);
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.resolve('data');
const archive = new ArchiveStore(ARCHIVE_DIR);
const BRIDGE_OBSERVATIONS_PATH = path.join(ARCHIVE_DIR, 'observations', 'bridge-events.jsonl');

function appendBridgeObservation(event) {
  fs.mkdirSync(path.dirname(BRIDGE_OBSERVATIONS_PATH), { recursive: true });
  fs.appendFileSync(BRIDGE_OBSERVATIONS_PATH, `${JSON.stringify({ schema_version: 1, event_id: crypto.randomUUID(), ...event })}\n`);
}

function bridgeFailureKind(error, last) {
  if (last?.visible_error === 'too_many_requests' || /too many requests/i.test(String(error?.message || ''))) return 'rate_limited';
  if (/No finished reply within|Timed out waiting/i.test(String(error?.message || ''))) return 'timeout';
  if (/No browser extension|not connected|No idle agent ChatGPT tab/i.test(String(error?.message || ''))) return 'broker';
  return 'unknown';
}

const app = express();
app.use(express.json({ limit: "2mb" }));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const extensionSockets = new Set();
const pending = new Map();
let bulkArchiveState = { running: false };
const bulkCompleteWaiters = new Set();
// The tab running a bulk archive, and how long to wait after it disconnects
// before declaring the run dead. Without this, closing or refreshing that tab
// left the scheduled sync "in progress" until its 12h timeout (2026-09-15).
const BULK_ORPHAN_GRACE_MS = Number(process.env.BULK_ORPHAN_GRACE_MS || 90000);
let bulkOwner = null;
let bulkOrphanTimer = null;

function finishBulk(msg) {
  clearTimeout(bulkOrphanTimer);
  bulkOrphanTimer = null;
  bulkArchiveState = { running: false, ...msg };
  for (const w of [...bulkCompleteWaiters]) w(msg);
}

async function checkBulkOrphan(owner) {
  bulkOrphanTimer = null;
  if (!bulkArchiveState.running || bulkOwner !== owner) return;
  // A dropped socket reconnects from the same page, which is still archiving
  // and says so; only a page that no longer reports busy has lost the run.
  if (typeof owner === "string") {
    try { if ((await dispatchToExtension({ action: "get_tab" }, 3000, { tab: owner })).busy) return; } catch { /* not connected */ }
  }
  const { running, type, ...counts } = bulkArchiveState;
  console.error("[broker] bulk archive abandoned: its ChatGPT tab disconnected and is not archiving");
  finishBulk({ type: "bulk_archive_complete", ...counts, failed: [], fatal_error: "the ChatGPT tab running the bulk archive disconnected (closed, refreshed, or extension reloaded) and is no longer archiving" });
}

function authOk(req) { return (req.headers.authorization || "") === `Bearer ${AUTH_TOKEN}`; }
function cleanTitle(v) { const s = String(v || '').trim(); if (!s || s.length > 120) throw new Error('title must be 1-120 characters'); return s; }

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/extension") return socket.destroy();
  if (url.searchParams.get("token") !== AUTH_TOKEN) {
    console.warn(`[broker] rejected extension upgrade from ${req.socket.remoteAddress}: bad or missing token`);
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  try {
    const params = new URL(req.url, "http://localhost").searchParams;
    ws.tabToken = params.get("tab") || null;
    ws.agentTab = params.get("agent") === "1";
  } catch { ws.tabToken = null; ws.agentTab = false; }
  extensionSockets.add(ws);
  console.log(`[broker] extension connected (${extensionSockets.size} total)`);
  ws.send(JSON.stringify({ type: "hello", message: "connected" }));
  ws.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg?.type === 'thread_snapshot') {
      try { const saved = archive.archiveSnapshot(msg.snapshot); ws.send(JSON.stringify({ type: 'snapshot_ack', thread_id: saved.thread_id, content_hash: saved.content_hash })); }
      catch (err) { console.error(`[broker] snapshot_error for ${msg.snapshot?.thread_id}: ${err.message}`); ws.send(JSON.stringify({ type: 'snapshot_error', error: err.message })); }
      return;
    }
    if (msg?.type === 'bulk_archive_progress') { bulkArchiveState = { running: true, ...msg }; bulkOwner = ws.tabToken || ws; clearTimeout(bulkOrphanTimer); bulkOrphanTimer = null; return; }
    if (msg?.type === 'bulk_archive_complete') { finishBulk(msg); console.log(`[broker] bulk archive complete: ${msg.archived}/${msg.total} archived, ${msg.failed?.length || 0} failed`); return; }
    if (msg?.type !== "command_result" || !msg?.id) return;
    const waiter = pending.get(msg.id); if (!waiter) return;
    waiter.onReply(msg);
  });
  ws.on("close", () => {
    extensionSockets.delete(ws);
    console.log(`[broker] extension disconnected (${extensionSockets.size} total)`);
    const owner = ws.tabToken || ws;
    if (bulkArchiveState.running && bulkOwner === owner && !bulkOrphanTimer) {
      bulkOrphanTimer = setTimeout(() => checkBulkOrphan(owner), BULK_ORPHAN_GRACE_MS);
    }
  });
  ws.on("error", (err) => { console.error(`[broker] extension socket error: ${err.message}`); extensionSockets.delete(ws); });
});

// Broadcasts to every connected tab (there may be several) and resolves on the
// first SUCCESS, not the first reply. A stale/incapable tab (e.g. one running
// pre-reload code, or sitting on a page where the action doesn't apply) can
// reply with an error faster than a capable tab that has to do real work
// (like scrolling the sidebar to find a background thread) — only failing
// once every connected tab has failed means one capable tab is enough,
// regardless of how many other tabs are also open.
// `single` sends to one tab only, for jobs (bulk archive) that must not run in
// every open chatgpt.com tab at once.
// `tab` sends to the one tab carrying that token (it survives the tab's own
// navigations), for actions that must happen in exactly one chosen tab.
function dispatchToExtension(command, timeoutMs = COMMAND_TIMEOUT_MS, { single = false, tab = null } = {}) {
  let sockets = [...extensionSockets].filter((ws) => ws.readyState === ws.OPEN);
  if (!sockets.length) throw new Error("No browser extension is connected to the broker.");
  if (tab) {
    sockets = sockets.filter((ws) => ws.tabToken === tab);
    if (!sockets.length) throw new Error(`ChatGPT tab ${tab.slice(0, 8)} is not connected (closed, or still reloading).`);
  } else {
    // Untargeted commands ("current chat", bulk archive) belong to Brian's own
    // tabs; the agent tab gets them only when it is the only tab open.
    const human = sockets.filter((ws) => !ws.agentTab);
    if (human.length) sockets = human;
  }
  if (single) sockets = sockets.slice(-1);
  const id = crypto.randomUUID();
  sockets.forEach((ws) => ws.send(JSON.stringify({ type: "command", id, ...command })));
  return new Promise((resolve, reject) => {
    let remaining = sockets.length;
    let lastError = null;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(lastError || new Error("Timed out waiting for the browser extension."));
    }, timeoutMs);
    pending.set(id, {
      onReply(msg) {
        if (msg.ok) {
          clearTimeout(timer);
          pending.delete(id);
          resolve(msg);
          return;
        }
        lastError = new Error(msg.error || "browser action failed");
        remaining--;
        if (remaining <= 0) {
          clearTimeout(timer);
          pending.delete(id);
          reject(lastError);
        }
      },
    });
  });
}

async function currentThreadId() {
  const result = await dispatchToExtension({ action: 'get_current_thread_info' });
  if (!result.thread_id) throw new Error('Could not determine current ChatGPT thread ID.');
  return result.thread_id;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The sidebar only ever renders a fixed recent batch of threads, so any
// thread-scoped UI action (move-to-project) has to happen from that thread's
// own page rather than by hovering a sidebar row that may not exist. A
// navigation tears down the extension's content-script instance immediately,
// so this can't be a single request/response — send navigate_to_thread (which
// the old instance acks just before it dies) and then poll until the fresh
// instance on the new page reports itself as current.
async function navigateToThread(threadId) {
  const cur = await currentThreadId().catch(() => null);
  if (cur === threadId) return;
  await dispatchToExtension({ action: 'navigate_to_thread', thread_id: threadId });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(700);
    try {
      // A short per-attempt timeout, not the full COMMAND_TIMEOUT_MS — otherwise
      // one slow-to-reconnect poll can single-handedly blow past this loop's
      // own 15s deadline before it ever gets to retry.
      const result = await dispatchToExtension({ action: 'get_current_thread_info' }, 3000);
      if (result.thread_id === threadId) return;
    } catch {
      /* extension is mid-reconnect after the navigation; keep polling */
    }
  }
  throw new Error(`Navigated toward thread ${threadId} but it never became the active tab within the timeout.`);
}

// Live chat list --------------------------------------------------------------
// One request to ChatGPT's own list of recent chats (newest first), read through a
// connected tab. It shares the account's request limit, so it is never paged.
async function listRecentChats(limit = 28) {
  const r = await dispatchToExtension({ action: "list_recent_chats", limit }, COMMAND_TIMEOUT_MS, { single: true });
  return r.chats || [];
}

// Case-insensitive title match: an exact title wins; otherwise every title that
// contains the query. The caller decides what zero or several matches mean.
function matchChatsByTitle(chats, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const exact = chats.filter((c) => (c.title || "").trim().toLowerCase() === q);
  return exact.length ? exact : chats.filter((c) => (c.title || "").toLowerCase().includes(q));
}

async function resolveThreadTitle(title) {
  const matches = matchChatsByTitle(await listRecentChats(100), title);
  if (matches.length === 1) return matches[0].id;
  if (!matches.length) throw new Error(`No chat among the 100 most recent has a title matching "${title}". Use list_chatgpt_chats or search_archived_chats to find its id.`);
  throw new Error(`"${title}" matches ${matches.length} chats; pass thread_id instead: ${matches.slice(0, 10).map((c) => `${c.id} "${c.title}"`).join("; ")}`);
}

// ask_chatgpt ------------------------------------------------------------------
// Send a message into a ChatGPT conversation through one idle tab and wait for
// the reply. One ask at a time: two concurrent asks would type into the same tab.
let askQueue = Promise.resolve();

// Agents only ever type into a tab opened for them (https://chatgpt.com/?ccm_agent=1),
// never into a tab Brian is using. With none open, the broker opens one.
const AGENT_TAB_URL = "https://chatgpt.com/?ccm_agent=1";
const AGENT_TAB_OPEN_CMD = process.env.AGENT_TAB_OPEN_CMD
  || (process.env.SYNC_OPEN_CHATGPT_CMD || "").replace(/https:\/\/chatgpt\.com\/?(?=\s|'|"|$)/, AGENT_TAB_URL)
  || null;
// WSL's bridge to Windows sometimes times out ("UtilAcceptVsock: accept4 failed
// 110") and works again seconds later (seen 2026-09-15), so a failed open is retried.
async function runOpenCommand(cmd, { attempts = 3, delayMs = 3000, exec = (c) => new Promise((resolve, reject) => execFile("/bin/sh", ["-c", c], (err, _out, stderr) => (err ? reject(new Error(`${err.message.split("\n")[0]} ${String(stderr || "").trim()}`.trim())) : resolve()))) } = {}) {
  const errors = [];
  for (let i = 1; i <= attempts; i++) {
    try { await exec(cmd); return { attempts: i }; }
    catch (err) { errors.push(`attempt ${i}: ${err.message}`); if (i < attempts) await sleep(delayMs); }
  }
  throw new Error(`opening the agent tab failed ${attempts} times: ${errors.join(" | ")}`);
}
let openAgentTab = async () => {
  if (!AGENT_TAB_OPEN_CMD || !AGENT_TAB_OPEN_CMD.includes("ccm_agent=1")) {
    throw new Error(`No agent ChatGPT tab is open, and the broker cannot open one (set AGENT_TAB_OPEN_CMD or SYNC_OPEN_CHATGPT_CMD). Open ${AGENT_TAB_URL} in Chrome.`);
  }
  await runOpenCommand(AGENT_TAB_OPEN_CMD);
};
function setAgentTabOpener(fn) { openAgentTab = fn; }

async function findIdleAgentTab(seen) {
  const tokens = [...new Set([...extensionSockets].filter((ws) => ws.readyState === ws.OPEN && ws.tabToken && ws.agentTab).map((ws) => ws.tabToken))];
  for (const tab of tokens) {
    try {
      const info = await dispatchToExtension({ action: "get_tab" }, 3000, { tab });
      seen.push({ tab: tab.slice(0, 8), busy: info.busy });
      if (!info.busy) return { tab, thread_id: info.thread_id || null };
    } catch (err) { seen.push({ tab: tab.slice(0, 8), error: err.message }); }
  }
  return null;
}

async function pickIdleTab({ openWaitMs = 90000 } = {}) {
  const seen = [];
  const found = await findIdleAgentTab(seen);
  if (found) return found;
  await openAgentTab();
  const deadline = Date.now() + openWaitMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const next = await findIdleAgentTab([]);
    if (next) return next;
  }
  throw new Error(`No idle agent ChatGPT tab (${JSON.stringify(seen)}); opened ${AGENT_TAB_URL} but it did not connect within ${Math.round(openWaitMs / 1000)}s (is Chrome signed in and the extension enabled?).`);
}

async function waitForTab(tab, predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(700);
    try { const info = await dispatchToExtension({ action: "get_tab" }, 3000, { tab }); if (predicate(info)) return info; }
    catch { /* reconnecting after navigation */ }
  }
  throw new Error(`ChatGPT tab never ${what} within ${Math.round(timeoutMs / 1000)}s.`);
}

async function askChatgpt({ text, thread_id = null, thread_title = null, timeout_seconds = 180, pollMs = 3000, openWaitMs = 90000 }) {
  const run = async () => {
    const body = String(text || "").trim();
    if (!body) throw new Error("text is required.");
    if (thread_id && thread_title) throw new Error("pass thread_id or thread_title, not both.");
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    let last = null;
    let resolvedThreadId = thread_id;
    let conversationMode = thread_id || thread_title ? 'continuing' : 'new';
    try {
      if (thread_title) resolvedThreadId = await resolveThreadTitle(thread_title);
      const { tab, thread_id: current } = await pickIdleTab({ openWaitMs });
      if (resolvedThreadId && current !== resolvedThreadId) {
        await dispatchToExtension({ action: "navigate_to_thread", thread_id: resolvedThreadId }, COMMAND_TIMEOUT_MS, { tab });
        await waitForTab(tab, (i) => i.thread_id === resolvedThreadId, 20000, `opened conversation ${resolvedThreadId}`);
      } else if (!resolvedThreadId && current) {
        await dispatchToExtension({ action: "navigate_home" }, COMMAND_TIMEOUT_MS, { tab });
        await waitForTab(tab, (i) => !i.thread_id, 20000, "opened a new chat");
      }
      const sent = await dispatchToExtension({ action: "send_prompt", text: body }, 90000, { tab });
      const deadline = Date.now() + timeout_seconds * 1000;
      let previousDoneText = null;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        try { last = await dispatchToExtension({ action: "get_reply", dom_before: sent.dom_before }, 30000, { tab }); }
        catch (err) { last = { done: false, error: err.message }; previousDoneText = null; continue; }
        if (!last.done) { previousDoneText = null; continue; }
        // The same finished text twice in a row: a pause mid-stream is not a reply.
        if (last.reply !== previousDoneText) { previousDoneText = last.reply; continue; }
        const threadId = last.thread_id || sent.thread_id || resolvedThreadId || null;
        appendBridgeObservation({ started_at: startedAt, ended_at: new Date().toISOString(), duration_ms: Date.now() - startedMs, outcome: 'success', failure_kind: null, visible_error: null, conversation_mode: conversationMode, thread_id: threadId, prompt_chars: body.length, history_message_count: Number.isInteger(last.message_count) ? last.message_count : null, history_chars: null, thinking_level: 'unknown' });
        return { thread_id: threadId, url: threadId ? `https://chatgpt.com/c/${threadId}` : null, reply: last.reply };
      }
      throw new Error(`No finished reply within ${timeout_seconds}s (last seen: ${JSON.stringify(last)}). The message was sent; check ChatGPT (conversation ${sent.thread_id || "id not yet assigned"}).`);
    } catch (err) {
      appendBridgeObservation({ started_at: startedAt, ended_at: new Date().toISOString(), duration_ms: Date.now() - startedMs, outcome: 'failed', failure_kind: bridgeFailureKind(err, last), visible_error: last?.visible_error || null, conversation_mode: conversationMode, thread_id: last?.thread_id || resolvedThreadId || null, prompt_chars: body.length, history_message_count: Number.isInteger(last?.message_count) ? last.message_count : null, history_chars: null, thinking_level: 'unknown' });
      throw err;
    }
  };
  const result = askQueue.then(run, run);
  askQueue = result.catch(() => {});
  return result;
}

app.post("/api/ask", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: "unauthorized" });
  try { res.json(await askChatgpt(req.body || {})); }
  catch (err) { res.status(503).json({ error: err.message }); }
});

app.get("/health", (_req, res) => res.json({ ok: true, extension_connections: extensionSockets.size, archive_dir: ARCHIVE_DIR }));
app.post('/api/capture', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try { const result = await dispatchToExtension({ action: 'capture_current_chat' }); res.json(result); }
  catch (err) { res.status(503).json({ error: err.message }); }
});
app.post('/api/move-to-project', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const project = String(req.body?.project || '').trim();
    if (!project) throw new Error('project is required');
    const targetThreadId = req.body?.thread_id || undefined;
    if (targetThreadId) await navigateToThread(targetThreadId);
    const result = await dispatchToExtension({ action: 'move_to_project', project, thread_id: targetThreadId });
    if (result.thread_id && result.project_ref) {
      try { archive.setNativeProjectRef(result.thread_id, result.project_ref); } catch { /* thread not archived locally yet; not fatal */ }
    }
    res.json(result);
  } catch (err) { res.status(err.message?.includes('No browser extension') || err.message?.includes('Timed out') ? 503 : 400).json({ error: err.message }); }
});
app.post("/api/rename", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: "unauthorized" });
  try { const result = await dispatchToExtension({ action: "rename_current_chat", title: cleanTitle(req.body?.title), thread_id: req.body?.thread_id || undefined }); res.json(result); }
  catch (err) { res.status(503).json({ error: err.message }); }
});
app.get('/api/search', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ results: archive.search(req.query.q || '', {
    project: req.query.project || null,
    limit: req.query.limit || 8,
    threadId: req.query.thread || null,
    status: req.query.status || null,
    since: req.query.since || null,
    until: req.query.until || null,
    tag: req.query.tag || null,
  }) });
});
app.post('/api/tag', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try { const id = req.body?.thread_id || (await currentThreadId()); res.json(archive.addTag(id, req.body?.tag)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/untag', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try { const id = req.body?.thread_id || (await currentThreadId()); res.json(archive.removeTag(id, req.body?.tag)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/current', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try { const result = await dispatchToExtension({ action: 'get_current_thread_info' }); res.json(result); }
  catch (err) { res.status(503).json({ error: err.message }); }
});
app.get('/api/thread/:id', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const catalog = archive.readCatalog();
  const t = catalog.threads[req.params.id];
  if (!t) return res.status(404).json({ error: `Unknown archived thread: ${req.params.id}` });
  res.json(t);
});
app.post('/api/project', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const project = String(req.body?.project || '').trim();
    if (!project) throw new Error('project is required');
    const id = req.body?.thread_id || (await currentThreadId());
    const t = archive.assignProject(id, project);
    archive.writeProjectWiki(t.project_id);
    res.json(t);
  } catch (err) { res.status(err.message?.includes('No browser extension') ? 503 : 400).json({ error: err.message }); }
});
app.post('/api/number', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { project, series = 'default', stage, sequence, thread_id, rename_visible_chat = true } = req.body || {};
    const id = thread_id || (await currentThreadId());
    const t = archive.numberThread(id, { projectName: project, series, stage, sequence });
    archive.writeProjectWiki(t.project_id);
    if (rename_visible_chat) {
      const prefix = String(t.sequence).padStart(2, '0');
      const cleanBase = String(t.title || 'Untitled').replace(/^\d{1,4}\s*[—–-]\s*/, '');
      const nextTitle = `${prefix} — ${stage ? `${stage} — ` : ''}${cleanBase}`.slice(0, 120);
      await dispatchToExtension({ action: 'rename_current_chat', title: nextTitle, thread_id: thread_id || undefined });
    }
    res.json(t);
  } catch (err) { res.status(err.message?.includes('No browser extension') || err.message?.includes('Timed out') ? 503 : 400).json({ error: err.message }); }
});
app.post('/api/lineage', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try { const id = req.body?.thread_id || (await currentThreadId()); res.json(archive.setThreadParent(id, req.body?.parent_thread_id || null)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/status', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try { const id = req.body?.thread_id || (await currentThreadId()); res.json(archive.setThreadStatus(id, req.body?.status)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/archive-all', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const incremental = req.body?.mode === 'incremental';
  try { const result = await dispatchToExtension({ action: 'archive_all_chats', known: incremental ? sync.knownThreads() : null }, COMMAND_TIMEOUT_MS, { single: true }); res.json(result); }
  catch (err) { res.status(503).json({ error: err.message }); }
});
app.get('/api/archive-all/status', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json(bulkArchiveState);
});
app.post('/api/sync', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  sync.runOnce();
  res.status(202).json({ started: true });
});
app.get('/api/sync-status', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json(sync.readStatus());
});
app.post('/api/undo', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try { const id = req.body?.thread_id || (await currentThreadId()); res.json(archive.undoLastAction(id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

function createMcpServer() {
  const mcp = new McpServer({ name: "chatgpt-conversation-manager", version: "0.3.0" });

  mcp.tool('ask_chatgpt', 'Send a message to ChatGPT in Brian\'s own logged-in browser and return its reply. Omit thread_id and thread_title to start a new chat; pass a conversation id, or a title that matches exactly one of the 100 most recent chats, to continue that conversation. Types only into the dedicated agent tab (https://chatgpt.com/?ccm_agent=1, opened automatically), never into a tab Brian is using, and waits up to timeout_seconds for the reply to finish.', {
    text: z.string().min(1),
    thread_id: z.string().optional(),
    thread_title: z.string().min(1).optional(),
    timeout_seconds: z.number().int().min(10).max(900).optional(),
  }, async ({ text, thread_id, thread_title, timeout_seconds }) => {
    try {
      const r = await askChatgpt({ text, thread_id: thread_id || null, thread_title: thread_title || null, timeout_seconds: timeout_seconds || 180 });
      return { content: [{ type: 'text', text: `${r.reply}\n\n[conversation ${r.thread_id} — ${r.url}]` }] };
    } catch (err) { return { isError: true, content: [{ type: 'text', text: `ask_chatgpt failed: ${err.message}` }] }; }
  });

  mcp.tool('list_chatgpt_chats', 'List Brian\'s most recent ChatGPT chats live from ChatGPT (newest first): id, title, last updated. Optional query filters by title. Use the id with ask_chatgpt to continue a chat. For older chats or searching message text, use search_archived_chats.', {
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, async ({ query, limit }) => {
    try {
      let chats = await listRecentChats(query ? 100 : (limit || 28));
      if (query) chats = matchChatsByTitle(chats, query).slice(0, limit || 28);
      const text = chats.length ? chats.map((c) => `${c.id}  ${c.title || '(untitled)'}  [updated ${c.update_time ?? 'unknown'}]`).join('\n') : (query ? `No recent chat title matches "${query}".` : 'No chats returned.');
      return { content: [{ type: 'text', text }] };
    } catch (err) { return { isError: true, content: [{ type: 'text', text: `list_chatgpt_chats failed: ${err.message}` }] }; }
  });

  mcp.tool('capture_current_chat', 'Capture the currently open ChatGPT conversation into the durable local archive.', {}, async () => {
    try { const r = await dispatchToExtension({ action: 'capture_current_chat' }); return { content: [{ type: 'text', text: `Captured ${r.thread_id}: ${r.title || 'Untitled'}` }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Capture failed: ${err.message}` }] }; }
  });

  mcp.tool("rename_current_chat", "Rename the currently open ChatGPT conversation. Use only when the user explicitly requests or approves the rename.", { title: z.string().min(1).max(120) }, async ({ title }) => {
    try { const r = await dispatchToExtension({ action: "rename_current_chat", title: cleanTitle(title) }); return { content: [{ type: "text", text: `Renamed the current chat to “${r.title || title}”.` }] }; }
    catch (err) { return { isError: true, content: [{ type: "text", text: `Rename failed: ${err.message}` }] }; }
  });

  mcp.tool("get_current_chat_title", "Read the title of the currently open ChatGPT conversation.", {}, async () => {
    try { const r = await dispatchToExtension({ action: "get_current_chat_title" }); return { content: [{ type: "text", text: r.title || "Current title could not be determined." }] }; }
    catch (err) { return { isError: true, content: [{ type: "text", text: `Read failed: ${err.message}` }] }; }
  });

  mcp.tool('assign_current_chat_project', 'Assign the current chat to a durable organizer project in the local archive. This does not depend on ChatGPT Projects UI.', { project: z.string().min(1).max(120) }, async ({ project }) => {
    try { const id = await currentThreadId(); const t = archive.assignProject(id, project.trim()); archive.writeProjectWiki(t.project_id); return { content: [{ type: 'text', text: `Assigned “${t.title}” to archive project “${t.project_name}”.` }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Project assignment failed: ${err.message}` }] }; }
  });

  mcp.tool('move_current_chat_to_project', 'Move the current chat into a native ChatGPT Project (visible in the ChatGPT sidebar), creating the project if it does not already exist. This mirrors organization into ChatGPT itself, separate from (and in addition to) the archive-side project assigned by assign_current_chat_project.', {
    project: z.string().min(1).max(120), thread_id: z.string().optional(),
  }, async ({ project, thread_id }) => {
    try { const result = await dispatchToExtension({ action: 'move_to_project', project: project.trim(), thread_id }); return { content: [{ type: 'text', text: `Moved chat to ChatGPT project “${project}”.` }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Move to project failed: ${err.message}` }] }; }
  });

  mcp.tool('number_current_chat', 'Assign the current archived chat a sequence number within its project/series.', {
    project: z.string().min(1).max(120).optional(),
    series: z.string().min(1).max(80).default('default'),
    stage: z.string().max(80).optional(),
    sequence: z.number().int().positive().optional(),
    rename_visible_chat: z.boolean().default(true),
  }, async ({ project, series, stage, sequence, rename_visible_chat }) => {
    try {
      const id = await currentThreadId();
      const t = archive.numberThread(id, { projectName: project, series, stage, sequence });
      archive.writeProjectWiki(t.project_id);
      const prefix = String(t.sequence).padStart(2, '0');
      const cleanBase = String(t.title || 'Untitled').replace(/^\d{1,4}\s*[—–-]\s*/, '');
      const nextTitle = `${prefix} — ${stage ? `${stage} — ` : ''}${cleanBase}`.slice(0, 120);
      if (rename_visible_chat) await dispatchToExtension({ action: 'rename_current_chat', title: nextTitle });
      return { content: [{ type: 'text', text: `Numbered thread ${prefix} in “${t.project_name}”${rename_visible_chat ? ` and renamed it to “${nextTitle}”` : ''}.` }] };
    } catch (err) { return { isError: true, content: [{ type: 'text', text: `Numbering failed: ${err.message}` }] }; }
  });

  mcp.tool('search_archived_chats', 'Search the durable ChatGPT archive using lexical/project-aware retrieval. Returns source snippets for retrieval-augmented use.', {
    query: z.string().min(1), project: z.string().optional(), limit: z.number().int().min(1).max(25).default(8),
    thread_id: z.string().optional(), status: z.enum(THREAD_STATUSES).optional(), since: z.string().optional(), until: z.string().optional(),
    tag: z.string().optional(),
  }, async ({ query, project, limit, thread_id, status, since, until, tag }) => {
    const rows = archive.search(query, { project, limit, threadId: thread_id, status, since, until, tag });
    const text = rows.length ? rows.map((r, i) => `${i + 1}. [${r.thread_id}] ${r.title}${r.project ? ` — ${r.project}` : ''}${r.status && r.status !== 'current' ? ` [${r.status}]` : ''}${r.tags?.length ? ` {${r.tags.join(', ')}}` : ''}\n${r.snippet}`).join('\n\n') : 'No archived chats matched.';
    return { content: [{ type: 'text', text }] };
  });

  mcp.tool('tag_thread', 'Add a secondary-relevance tag to the current chat (or a specific thread_id). Distinct from the primary project — a thread can have many tags but only one primary project, since numbering/sequencing only makes sense within one project.', {
    tag: z.string().min(1).max(60), thread_id: z.string().optional(),
  }, async ({ tag, thread_id }) => {
    try { const id = thread_id || (await currentThreadId()); const t = archive.addTag(id, tag); return { content: [{ type: 'text', text: `Tagged "${t.title}" with "${tag}". Tags: ${(t.tags || []).join(', ')}` }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Tag failed: ${err.message}` }] }; }
  });

  mcp.tool('untag_thread', 'Remove a secondary-relevance tag from the current chat (or a specific thread_id).', {
    tag: z.string().min(1), thread_id: z.string().optional(),
  }, async ({ tag, thread_id }) => {
    try { const id = thread_id || (await currentThreadId()); const t = archive.removeTag(id, tag); return { content: [{ type: 'text', text: `Removed tag "${tag}" from "${t.title}". Tags: ${(t.tags || []).join(', ') || '(none)'}` }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Untag failed: ${err.message}` }] }; }
  });

  mcp.tool('set_thread_parent', 'Record a parent/lineage link for the current chat (e.g. this thread continues or revises another archived thread). Purely metadata; no automatic inference.', {
    parent_thread_id: z.string().min(1).nullable(),
  }, async ({ parent_thread_id }) => {
    try { const id = await currentThreadId(); const t = archive.setThreadParent(id, parent_thread_id); return { content: [{ type: 'text', text: parent_thread_id ? `Set parent of "${t.title}" to ${parent_thread_id}.` : `Cleared parent link for "${t.title}".` }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Set parent failed: ${err.message}` }] }; }
  });

  mcp.tool('set_thread_status', `Set the lifecycle status of the current chat. One of: ${THREAD_STATUSES.join(', ')}.`, {
    status: z.enum(THREAD_STATUSES),
  }, async ({ status }) => {
    try { const id = await currentThreadId(); const t = archive.setThreadStatus(id, status); archive.writeProjectWiki(t.project_id); return { content: [{ type: 'text', text: `Set "${t.title}" status to ${status}.` }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Set status failed: ${err.message}` }] }; }
  });

  mcp.tool('undo_last_organization_change', 'Undo the most recent archive-side organization change (project assignment, sequence/series/stage, or status) for a thread. Does not undo the visible ChatGPT UI rename or checkpoints — the append-only history preserves prior titles for manual restoration.', {
    thread_id: z.string().optional(),
  }, async ({ thread_id }) => {
    try { const id = thread_id || (await currentThreadId()); const t = archive.undoLastAction(id); if (t.project_id) archive.writeProjectWiki(t.project_id); return { content: [{ type: 'text', text: `Reverted last organization change for "${t.title}".` }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Undo failed: ${err.message}` }] }; }
  });

  mcp.tool('get_project_state', 'Get the current archive state for a project: thread index (with sequence/stage/status) and the compiled wiki page content.', {
    project: z.string().min(1),
  }, async ({ project }) => {
    const catalog = archive.readCatalog();
    const projectId = Object.values(catalog.projects).find((p) => p.name.toLowerCase() === project.toLowerCase() || p.project_id === project)?.project_id;
    if (!projectId) return { content: [{ type: 'text', text: `No archive project matches "${project}".` }] };
    const threads = Object.values(catalog.threads)
      .filter((t) => t.project_id === projectId)
      .sort((a, b) => (a.sequence || 999999) - (b.sequence || 999999));
    const summary = threads.map((t) => `${t.sequence ? String(t.sequence).padStart(2, '0') : '--'} ${t.title}${t.stage ? ` — ${t.stage}` : ''}${t.status !== 'current' ? ` [${t.status}]` : ''} (${t.thread_id})`).join('\n');
    return { content: [{ type: 'text', text: `Project "${catalog.projects[projectId].name}" — ${threads.length} thread(s):\n${summary || '(none)'}` }] };
  });

  mcp.tool('save_current_chat_checkpoint', 'Save a durable project-memory checkpoint for the current chat. The summary and decisions should reflect the conversation, not invent new facts.', {
    summary: z.string().min(1),
    status: z.enum(['proposed','accepted','rejected','superseded','unresolved','current']).default('current'),
    decisions: z.array(z.string()).default([]),
    open_questions: z.array(z.string()).default([]),
    next_steps: z.array(z.string()).default([]),
    source_message_ids: z.array(z.string()).default([]),
  }, async (cp) => {
    try { const id = await currentThreadId(); const saved = archive.saveCheckpoint(id, cp); return { content: [{ type: 'text', text: `Saved checkpoint ${saved.checkpoint_id}.` }] }; }
    catch (err) { return { isError: true, content: [{ type: 'text', text: `Checkpoint failed: ${err.message}` }] }; }
  });

  return mcp;
}

app.all("/mcp", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: "unauthorized" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcp = createMcpServer();
  res.on("close", () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
  try { await mcp.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

function waitForBulkComplete(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bulkCompleteWaiters.delete(done); reject(new Error(`bulk archive did not complete within ${Math.round(timeoutMs / 60000)} minutes`)); }, timeoutMs);
    const done = (msg) => { clearTimeout(timer); bulkCompleteWaiters.delete(done); resolve(msg); };
    bulkCompleteWaiters.add(done);
  });
}

const sync = new SyncScheduler({
  archive,
  dispatch: (command) => dispatchToExtension(command, COMMAND_TIMEOUT_MS, { single: true }),
  connectionCount: () => [...extensionSockets].filter((ws) => ws.readyState === ws.OPEN).length,
  waitForBulkComplete,
  statusPath: path.join(ARCHIVE_DIR, 'metadata', 'sync-status.json'),
  openCommand: process.env.SYNC_OPEN_CHATGPT_CMD || null,
});
const SYNC_INTERVAL_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES || 0);

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  server.listen(PORT, () => {
    console.log(`Conversation manager listening on http://localhost:${PORT}`);
    console.log(`Archive: ${ARCHIVE_DIR}`);
    console.log(`MCP:     http://localhost:${PORT}/mcp`);
    if (SYNC_INTERVAL_MINUTES > 0) {
      sync.start(SYNC_INTERVAL_MINUTES * 60 * 1000);
      console.log(`Sync:    incremental backup every ${SYNC_INTERVAL_MINUTES} min (status: GET /api/sync-status)`);
    }
  });
}

export { app, server, archive, sync, askChatgpt, waitForBulkComplete, setAgentTabOpener, matchChatsByTitle, runOpenCommand, BRIDGE_OBSERVATIONS_PATH };
