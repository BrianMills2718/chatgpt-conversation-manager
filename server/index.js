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
import { AdaptivePacer } from '../extension/lib/api-capture.js';

const PORT = Number(process.env.PORT || 8787);
const AUTH_TOKEN = process.env.RENAMER_TOKEN || "change-me";
// server.log's own console lines had no timestamps, making it impossible to
// correlate broker activity (tab connects, sync/archive outcomes) against
// timed data like request-timing.jsonl when reconstructing an incident after
// the fact (2026-09-18: asked to explain a rate-limit spike against Brian's
// own concurrent usage and could not line the two up in time).
function logLine(fn, msg) { fn(`${new Date().toISOString()} ${msg}`); }
const logInfo = (msg) => logLine(console.log, msg);
const logWarn = (msg) => logLine(console.warn, msg);
const logErr = (msg) => logLine(console.error, msg);
// The sidebar-scroll-based commands (rename/move-to-project for a background
// thread) have their own client-side budget of up to ~80 * 300ms = 24s just to
// locate the thread in a virtualized list, before any menu interaction. This
// must stay comfortably above that worst case or the server times out a
// command that was still legitimately in progress.
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS || 40000);
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.resolve('data');
const archive = new ArchiveStore(ARCHIVE_DIR);
const BRIDGE_OBSERVATIONS_PATH = path.join(ARCHIVE_DIR, 'observations', 'bridge-events.jsonl');

// Real backend text observed 2026-09-17: "You're making requests too
// quickly. We've temporarily limited access to your conversations to
// protect your data." The prior pattern only matched a generic "too many
// requests" phrase and would have missed this exact banner -- broadened so
// the same real signal drives both the failure classification below and the
// agent request pacer, instead of only being noticed when Brian reports it.
const RATE_LIMIT_TEXT = /too many requests|making requests too quickly|temporarily limited access to your conversations/i;

function appendBridgeObservation(event) {
  fs.mkdirSync(path.dirname(BRIDGE_OBSERVATIONS_PATH), { recursive: true });
  fs.appendFileSync(BRIDGE_OBSERVATIONS_PATH, `${JSON.stringify({ schema_version: 1, event_id: crypto.randomUUID(), ...event })}\n`);
}

function bridgeFailureKind(error, last) {
  if (last?.visible_error === 'too_many_requests' || RATE_LIMIT_TEXT.test(String(error?.message || ''))) return 'rate_limited';
  if (/^Could not confirm the prompt was sent/.test(String(error?.message || ''))) return 'send_unconfirmed';
  if (/^Refusing to return a reply/.test(String(error?.message || ''))) return 'attribution_mismatch';
  if (/No finished reply within|Timed out waiting/i.test(String(error?.message || ''))) return 'timeout';
  // Send-step failures the extension raises before anything was sent.
  if (/no ChatGPT composer found|no enabled send button found|prompt text did not appear in the composer|composer did not end up holding exactly this prompt/i.test(String(error?.message || ''))) return 'browser_ui';
  if (/No browser extension|not connected|No idle agent ChatGPT tab/i.test(String(error?.message || ''))) return 'broker';
  return 'unknown';
}

// Agent request pacing and timing -----------------------------------------
// Every ask_chatgpt/list_chatgpt_chats call goes through dispatchToExtension
// below, but until now nothing paced or recorded them: a burst of live
// verification calls on 2026-09-17 (list_recent_chats + concurrent
// send_prompt/get_reply cycles) tripped ChatGPT's account-wide rate limit,
// observed directly by Brian in his own ChatGPT UI, with no record of the
// request timing that caused it. This reuses the same AIMD pacer already
// proven for bulk-archive fetches (extension/lib/api-capture.js) -- every
// success shortens the minimum gap a little, every detected rate-limit
// signal doubles it -- so the gap settles just under whatever rate the
// account actually tolerates instead of a guessed constant, and it is
// persisted to disk so a broker restart does not forget a learned slowdown.
const REQUEST_TIMING_PATH = path.join(ARCHIVE_DIR, 'observations', 'request-timing.jsonl');
const AGENT_PACER_STATE_PATH = path.join(ARCHIVE_DIR, 'observations', 'agent-pacer-state.json');
// Actions that make a real request against ChatGPT's backend (not a pure
// local DOM/status read like get_tab or navigate_home).
const BACKEND_TOUCHING_ACTIONS = new Set(['send_prompt', 'get_reply', 'list_recent_chats', 'capture_current_chat']);

// One pacer per ChatGPT account, not one global pacer, so a rate-limit signal
// on one account's quota does not throttle every other connected account too
// (found 2026-09-25: a single shared agentPacer meant adding a second account
// for load-spreading or team sharing would have undermined its own point --
// see GOAL.md Phase 3). `agentPacer` below stays a plain AdaptivePacer for
// backward compatibility with existing single-account tests/callers -- it is
// literally the '(default)' account's entry, used whenever no explicit
// account is requested.
const DEFAULT_PACER_KEY = '(default)';
function normalizePacerKey(account) { return account ? String(account).trim().toLowerCase() : DEFAULT_PACER_KEY; }

function loadAgentPacerState() {
  try { return JSON.parse(fs.readFileSync(AGENT_PACER_STATE_PATH, 'utf8')); } catch { return null; }
}
// The pre-2026-09-25 file was a flat {spacingMs, rateLimited, successes}
// object for the single global pacer; treat that shape as the default
// account's saved state instead of discarding a machine's already-learned
// spacing on the first restart after this change.
function migrateLegacyPacerState(raw) {
  return raw && typeof raw.spacingMs === 'number' ? { [DEFAULT_PACER_KEY]: raw } : (raw || {});
}
function saveAgentPacerState() {
  fs.mkdirSync(path.dirname(AGENT_PACER_STATE_PATH), { recursive: true });
  const out = {};
  for (const [key, entry] of accountPacers) {
    out[key] = { spacingMs: entry.pacer.spacingMs, rateLimited: entry.pacer.rateLimited, successes: entry.pacer.successes };
  }
  fs.writeFileSync(AGENT_PACER_STATE_PATH, JSON.stringify(out));
}
const _savedPacerStateByKey = migrateLegacyPacerState(loadAgentPacerState());
const accountPacers = new Map();
function getPacerEntry(key) {
  let entry = accountPacers.get(key);
  if (entry) return entry;
  const saved = _savedPacerStateByKey[key];
  const pacer = new AdaptivePacer({ initialMs: saved?.spacingMs ?? 3000, minMs: 1000, maxMs: 120000 });
  if (saved) { pacer.rateLimited = saved.rateLimited || 0; pacer.successes = saved.successes || 0; }
  entry = { pacer, lastRequestAt: 0 };
  accountPacers.set(key, entry);
  return entry;
}
const agentPacer = getPacerEntry(DEFAULT_PACER_KEY).pacer;
// How many paced dispatches are currently waiting on or executing a real
// request at once -- a direct measure of concurrency pressure, independent
// of the minimum-gap the pacer enforces, for correlating a future rate-limit
// event against "was this a burst of parallel calls" specifically.
let agentRequestsInFlight = 0;
// A minimum gap between requests prevents zero-gap spamming by construction,
// but says nothing about a longer rolling-window rate (e.g. "no more than N
// in 60s") that a low, well-decayed gap could still exceed. Recording how
// many backend-touching requests fell within the last 60s/300s at the time
// of each dispatch is what actually lets a future incident be diagnosed as
// "raw rate" vs "burst" vs neither, instead of guessing.
const REQUEST_WINDOW_MS = 5 * 60 * 1000;
const recentAgentRequestTimestamps = [];
function recordAndCountWindow(nowMs) {
  recentAgentRequestTimestamps.push(nowMs);
  const cutoff = nowMs - REQUEST_WINDOW_MS;
  while (recentAgentRequestTimestamps.length && recentAgentRequestTimestamps[0] < cutoff) recentAgentRequestTimestamps.shift();
  const last60s = recentAgentRequestTimestamps.filter((t) => t >= nowMs - 60000).length;
  return { requests_last_60s: last60s, requests_last_300s: recentAgentRequestTimestamps.length };
}

function appendRequestTiming(event) {
  fs.mkdirSync(path.dirname(REQUEST_TIMING_PATH), { recursive: true });
  fs.appendFileSync(REQUEST_TIMING_PATH, `${JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), ...event })}\n`);
}

// Zero-network-cost record of Brian's own ChatGPT activity (which tab, which
// thread, whether a mutation was attempted/skipped/throttled), timestamped
// against the same clock as request-timing.jsonl so the two can be lined up
// for a future incident instead of reconstructed from memory.
const DOM_ACTIVITY_PATH = path.join(ARCHIVE_DIR, 'observations', 'dom-activity.jsonl');
function appendDomActivity(event) {
  fs.mkdirSync(path.dirname(DOM_ACTIVITY_PATH), { recursive: true });
  fs.appendFileSync(DOM_ACTIVITY_PATH, `${JSON.stringify({ schema_version: 1, ts: new Date().toISOString(), ...event })}\n`);
}

function isRateLimitSignal(err, result) {
  if (result?.visible_error === 'too_many_requests' || result?.api_status === 429) return true;
  if (err?.api_status === 429 || err?.visible_error === 'too_many_requests') return true;
  return RATE_LIMIT_TEXT.test(String(err?.message || result?.error || ''));
}
function retryAfterMsOf(err, result) {
  return result?.api_retry_after_ms ?? err?.api_retry_after_ms ?? null;
}

// AdaptivePacer.onRateLimit(retryAfterMs) only DOUBLES its own persisted
// spacingMs internally; the retry-after-aware wait lives solely in its
// return value, designed for a caller that awaits it once immediately
// (extension/lib/api-capture.js's captureWithRecovery does exactly that).
// This pacer instead persists spacingMs as an ongoing minimum gap across
// unrelated future calls, so when ChatGPT tells us an authoritative
// Retry-After, that has to become the new floor directly -- otherwise the
// real value the account just told us is silently discarded and only the
// blind doubling survives.
function applyRateLimit(retryAfterMs, pacerKey = DEFAULT_PACER_KEY) {
  const pacer = getPacerEntry(pacerKey).pacer;
  const suggested = pacer.onRateLimit(retryAfterMs);
  if (retryAfterMs != null) pacer.spacingMs = Math.max(pacer.spacingMs, suggested);
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
  logErr("[broker] bulk archive abandoned: its ChatGPT tab disconnected and is not archiving");
  finishBulk({ type: "bulk_archive_complete", ...counts, failed: [], fatal_error: "the ChatGPT tab running the bulk archive disconnected (closed, refreshed, or extension reloaded) and is no longer archiving" });
}

// The extension's background worker compares this with its running version and
// reloads itself when they differ (extension/background.js), so a merged
// extension change reaches every browser without a manual reload. Read from
// disk on each request so a git merge is picked up without restarting.
const EXTENSION_MANIFEST_PATH = new URL('../extension/manifest.json', import.meta.url);
function extensionVersionOnDisk() {
  try { return JSON.parse(fs.readFileSync(EXTENSION_MANIFEST_PATH, 'utf8')).version || null; }
  catch (err) { logErr(`[broker] cannot read extension manifest version: ${err.message}`); return null; }
}

function authOk(req) { return (req.headers.authorization || "") === `Bearer ${AUTH_TOKEN}`; }
function cleanTitle(v) { const s = String(v || '').trim(); if (!s || s.length > 120) throw new Error('title must be 1-120 characters'); return s; }

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/extension") return socket.destroy();
  if (url.searchParams.get("token") !== AUTH_TOKEN) {
    logWarn(`[broker] rejected extension upgrade from ${req.socket.remoteAddress}: bad or missing token`);
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  try {
    const params = new URL(req.url, "http://localhost").searchParams;
    ws.tabToken = params.get("tab") || null;
    ws.agentTab = params.get("agent") === "1";
    ws.extensionVersion = params.get("v") || null;
  } catch { ws.tabToken = null; ws.agentTab = false; ws.extensionVersion = null; }
  // A tab keeps its token across reloads, so a new socket carrying a token that
  // is already connected means the old one belongs to superseded code (an
  // extension update leaves the previous content script alive in the page with
  // its socket still open, able to act on commands a second time). Close it
  // with 4001 so it stops; current code that receives 4001 while still alive
  // (e.g. a duplicated tab sharing sessionStorage) takes a fresh token instead.
  if (ws.tabToken) {
    for (const other of extensionSockets) {
      if (other.tabToken === ws.tabToken && other.readyState === other.OPEN) {
        logInfo(`[broker] tab ${ws.tabToken.slice(0, 8)} reconnected; closing its superseded socket`);
        try { other.close(4001, 'superseded'); } catch {}
        extensionSockets.delete(other);
      }
    }
  }
  extensionSockets.add(ws);
  logInfo(`[broker] extension connected (${extensionSockets.size} total)`);
  // Extension fixes only run once Chrome reloads the extension; 0.7.3 sat on
  // disk for over an hour (2026-09-27) while the tabs kept running 0.7.2.
  const onDisk = extensionVersionOnDisk();
  if (ws.extensionVersion !== onDisk) {
    logWarn(`[broker] tab ${ws.tabToken?.slice(0, 8) ?? '?'} runs extension ${ws.extensionVersion || 'older than 0.7.4 (unreported)'} but ${onDisk} is on disk; its fixes are not live until Chrome reloads the extension (chrome://extensions, reload "ChatGPT Conversation Manager Bridge").`);
  }
  ws.send(JSON.stringify({ type: "hello", message: "connected" }));
  ws.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg?.type === 'identity') {
      ws.account = msg.account && (msg.account.email || msg.account.user_id) ? msg.account : null;
      logInfo(`[broker] tab ${ws.tabToken?.slice(0, 8) ?? '?'} is signed into ${ws.account?.email || ws.account?.user_id || 'no readable account'}`);
      return;
    }
    if (msg?.type === 'background_status') {
      // The tab pinged the extension's background worker (from 0.7.6). Without
      // a worker nothing reloads the extension onto a new on-disk version; that
      // went unnoticed 2026-09-26/27 while 0.7.2-0.7.5 sat on disk.
      ws.backgroundOk = msg.ok === true;
      if (!ws.backgroundOk) logWarn(`[broker] tab ${ws.tabToken?.slice(0, 8) ?? '?'}: the extension's background worker did not answer (${msg.error || 'no reason given'}), so the extension cannot reload itself onto new versions. Reload it by hand: chrome://extensions, reload "ChatGPT Conversation Manager Bridge".`);
      return;
    }
    if (msg?.type === 'dom_activity') {
      // Purely local signal the extension already computed from the DOM
      // (thread id, message-count/role/length key, whether a capture was
      // attempted/skipped/throttled) -- this is how Brian's own ChatGPT
      // activity becomes visible without any of it costing a real request
      // against ChatGPT itself.
      appendDomActivity({
        tab: ws.tabToken?.slice(0, 8) ?? null, agent_tab: ws.agentTab ?? null,
        thread_id: msg.thread_id ?? null, dom_key: msg.dom_key ?? null, outcome: msg.outcome ?? null,
      });
      return;
    }
    if (msg?.type === 'thread_snapshot') {
      // Auto-archive pushes this straight over the socket -- it never goes
      // through dispatchToExtension/agentPacer, so without this it was
      // completely invisible to the same request-timing log and rate-limit
      // reaction that covers ask_chatgpt/list_chatgpt_chats (found 2026-09-18
      // investigating a rate-limit spike that coincided with heavy multi-tab
      // use, not any explicit agent call). Logged into the same timeline
      // under action "auto_capture" so both sources are comparable.
      const autoCaptureRateLimited = msg.api_error_status === 429;
      const autoCapturePacerKey = normalizePacerKey(accountKey(ws.account));
      // Conservative for this tab's own account only -- a different account
      // connected in another tab has its own independent quota and pacer.
      if (autoCaptureRateLimited) applyRateLimit(null, autoCapturePacerKey);
      appendRequestTiming({
        action: 'auto_capture', ok: true, rate_limited: autoCaptureRateLimited, api_status: msg.api_error_status ?? null,
        account: autoCapturePacerKey === DEFAULT_PACER_KEY ? null : autoCapturePacerKey,
        tab: ws.tabToken?.slice(0, 8) ?? null, agent_tab: ws.agentTab ?? null, spacing_ms: getPacerEntry(autoCapturePacerKey).pacer.spacingMs,
        ...recordAndCountWindow(Date.now()),
      });
      try { const saved = archive.archiveSnapshot(msg.snapshot); ws.send(JSON.stringify({ type: 'snapshot_ack', thread_id: saved.thread_id, content_hash: saved.content_hash })); }
      catch (err) { logErr(`[broker] snapshot_error for ${msg.snapshot?.thread_id}: ${err.message}`); ws.send(JSON.stringify({ type: 'snapshot_error', error: err.message })); }
      return;
    }
    if (msg?.type === 'bulk_archive_progress') { bulkArchiveState = { running: true, ...msg }; bulkOwner = ws.tabToken || ws; clearTimeout(bulkOrphanTimer); bulkOrphanTimer = null; return; }
    if (msg?.type === 'bulk_archive_complete') { finishBulk(msg); logInfo(`[broker] bulk archive complete: ${msg.archived}/${msg.total} archived, ${msg.failed?.length || 0} failed`); return; }
    if (msg?.type !== "command_result" || !msg?.id) return;
    const waiter = pending.get(msg.id); if (!waiter) return;
    waiter.onReply(msg);
  });
  ws.on("close", () => {
    extensionSockets.delete(ws);
    logInfo(`[broker] extension disconnected (${extensionSockets.size} total)`);
    const owner = ws.tabToken || ws;
    if (bulkArchiveState.running && bulkOwner === owner && !bulkOrphanTimer) {
      bulkOrphanTimer = setTimeout(() => checkBulkOrphan(owner), BULK_ORPHAN_GRACE_MS);
    }
  });
  ws.on("error", (err) => { logErr(`[broker] extension socket error: ${err.message}`); extensionSockets.delete(ws); });
});

// Accounts --------------------------------------------------------------------
// Each tab reports which ChatGPT account it is signed into (content.js
// reportIdentity). `account` arguments match an email (case-insensitive) or a
// user id. Several browsers/profiles signed into different accounts can all be
// connected at once; reads and asks are routed to a tab on the right account.
function accountMatches(identity, wanted) {
  if (!identity || !wanted) return false;
  const w = String(wanted).trim().toLowerCase();
  return (identity.email || '').toLowerCase() === w || (identity.user_id || '').toLowerCase() === w;
}
function accountKey(identity) { return identity ? (identity.email || identity.user_id) : null; }
function connectedAccounts() {
  return [...new Set([...extensionSockets].filter((ws) => ws.readyState === ws.OPEN && ws.account).map((ws) => accountKey(ws.account)))];
}
function noAccountTabMessage(account) {
  const have = connectedAccounts();
  return `No connected ChatGPT tab is signed into ${account}. Connected accounts: ${have.length ? have.join(', ') : 'none reported'}. Open https://chatgpt.com in a browser profile signed into that account with this extension installed.`;
}
function listConnections() {
  return [...extensionSockets].filter((ws) => ws.readyState === ws.OPEN).map((ws) => ({
    tab: ws.tabToken ? ws.tabToken.slice(0, 8) : null, agent: Boolean(ws.agentTab),
    account: accountKey(ws.account), account_name: ws.account?.name || null, plan: ws.account?.plan || null,
    extension_version: ws.extensionVersion || null,
  }));
}
// One open socket per distinct account (unknown-account tabs grouped together),
// preferring an agent tab so reads never touch a tab Brian is typing in.
function oneSocketPerAccount() {
  const byKey = new Map();
  for (const ws of [...extensionSockets].filter((w) => w.readyState === w.OPEN && w.tabToken)) {
    const key = accountKey(ws.account) || '(unknown account)';
    const prev = byKey.get(key);
    if (!prev || (!prev.agentTab && ws.agentTab)) byKey.set(key, ws);
  }
  return [...byKey.entries()].map(([key, ws]) => ({ key, tab: ws.tabToken }));
}

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
//
// Wrapped below by the paced/logged public dispatchToExtension; this raw
// form keeps its exact original synchronous-throw and broadcast semantics.
function dispatchToExtensionRaw(command, timeoutMs = COMMAND_TIMEOUT_MS, { single = false, tab = null, account = null } = {}) {
  let sockets = [...extensionSockets].filter((ws) => ws.readyState === ws.OPEN);
  if (!sockets.length) throw new Error("No browser extension is connected to the broker.");
  if (account) {
    sockets = sockets.filter((ws) => accountMatches(ws.account, account));
    if (!sockets.length) throw new Error(noAccountTabMessage(account));
  }
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
        // Carry the tab/context fields the extension attaches to every
        // reply (see content.js's requestContext) onto the rejection too,
        // so a paced dispatch that fails still logs which tab/context it
        // came from instead of losing everything but the error text.
        lastError = Object.assign(new Error(msg.error || "browser action failed"), {
          tab: msg.tab, agent: msg.agent, incognito: msg.incognito,
          api_status: msg.api_status, api_retry_after_ms: msg.api_retry_after_ms,
          // send_prompt's pre-typing failures (content.js sendPrompt): which
          // step failed, that nothing was typed, which page instance it was,
          // and whether ChatGPT's rate-limit banner was showing.
          stage: msg.stage, nothing_sent: msg.nothing_sent, page_id: msg.page_id, visible_error: msg.visible_error,
        });
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

// reload_tab tears its own page down as soon as it fires (content.js's
// location.reload()), so there is no meaningful "reply" to wait for the way
// every other dispatched command has one -- the normal targeted request/
// response path in dispatchToExtensionRaw (pick Brian's tabs over the agent
// tab, resolve on the first success) does not fit a command whose whole point
// is to hit every stale tab at once, agent tab included. This is deliberately
// a separate, simpler broadcast: send-and-forget to every open socket, report
// only how many were reached, and let the caller re-verify success with a
// normal call afterward (e.g. a fresh ask_chatgpt) rather than trusting this
// one's own return value.
function broadcastReloadTab() {
  const sockets = [...extensionSockets].filter((ws) => ws.readyState === ws.OPEN);
  if (!sockets.length) throw new Error("No browser extension is connected to the broker.");
  const id = crypto.randomUUID();
  for (const ws of sockets) ws.send(JSON.stringify({ type: "command", id, action: "reload_tab" }));
  return { sent_to: sockets.length };
}

// get_reply is dispatched every poll cycle but only actually reaches
// ChatGPT's backend roughly once per 10s per tab (its own internal
// api-check cooldown, extension/content.js) -- the rest are free, local DOM
// reads. Gating every get_reply behind the pacer's gap would throttle calls
// that never touch the account's quota at all, which works against "as much
// usage as possible" for no safety benefit. So get_reply is only pre-gated,
// counted, and reacted to as a real request when its OWN result says it
// actually checked the API (api_checked) or actually failed trying to
// (err.api_status set) -- everything else in this set always makes a real
// request and is paced unconditionally.
const ALWAYS_REAL_ACTIONS = new Set(['send_prompt', 'list_recent_chats', 'capture_current_chat']);

// Waits out the account's current pacer gap without recording a request.
async function waitForPacerGap(account) {
  const entry = getPacerEntry(normalizePacerKey(account));
  const waitMs = entry.pacer.spacingMs - (Date.now() - entry.lastRequestAt);
  if (waitMs > 0) await sleep(waitMs);
}

async function dispatchToExtension(command, timeoutMs = COMMAND_TIMEOUT_MS, opts = {}) {
  const tracked = BACKEND_TOUCHING_ACTIONS.has(command.action);
  const alwaysReal = ALWAYS_REAL_ACTIONS.has(command.action);
  const pacerKey = normalizePacerKey(opts.account);
  const entry = getPacerEntry(pacerKey);
  if (alwaysReal) await waitForPacerGap(opts.account);
  if (tracked) agentRequestsInFlight++;
  const startedMs = Date.now();
  try {
    const result = await dispatchToExtensionRaw(command, timeoutMs, opts);
    const real = alwaysReal || (command.action === 'get_reply' && result?.api_checked);
    if (real) {
      entry.lastRequestAt = Date.now();
      const rateLimited = isRateLimitSignal(null, result);
      if (rateLimited) applyRateLimit(retryAfterMsOf(null, result), pacerKey); else entry.pacer.onSuccess();
      saveAgentPacerState();
      appendRequestTiming({
        action: command.action, ok: true, duration_ms: Date.now() - startedMs, rate_limited: rateLimited, spacing_ms: entry.pacer.spacingMs,
        account: pacerKey === DEFAULT_PACER_KEY ? null : pacerKey,
        tab: result?.tab?.slice(0, 8) ?? null, agent_tab: result?.agent ?? null, incognito: result?.incognito ?? null,
        api_checked: result?.api_checked ?? null, api_status: result?.api_status ?? null,
        ...(command.action === 'send_prompt' ? { send_confirmed: result?.send_confirmed ?? null, confirmed_by: result?.confirmed_by ?? null, visibility: result?.visibility ?? null } : {}),
        in_flight: agentRequestsInFlight, ...recordAndCountWindow(Date.now()),
      });
    }
    return result;
  } catch (err) {
    const real = alwaysReal || (command.action === 'get_reply' && err?.api_status != null);
    if (real) {
      entry.lastRequestAt = Date.now();
      const rateLimited = isRateLimitSignal(err, null);
      if (rateLimited) { applyRateLimit(retryAfterMsOf(err, null), pacerKey); saveAgentPacerState(); }
      appendRequestTiming({
        action: command.action, ok: false, duration_ms: Date.now() - startedMs, rate_limited: rateLimited, error: err.message, spacing_ms: entry.pacer.spacingMs,
        account: pacerKey === DEFAULT_PACER_KEY ? null : pacerKey,
        tab: err?.tab?.slice(0, 8) ?? null, agent_tab: err?.agent ?? null, incognito: err?.incognito ?? null,
        api_status: err?.api_status ?? null, in_flight: agentRequestsInFlight, ...recordAndCountWindow(Date.now()),
      });
    }
    throw err;
  } finally {
    if (tracked) agentRequestsInFlight--;
  }
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
async function listRecentChats(limit = 28, { account = null, includeProjects = false } = {}) {
  const r = await dispatchToExtension({ action: "list_recent_chats", limit }, COMMAND_TIMEOUT_MS, { single: true, account });
  const chats = (r.chats || []).map((c) => ({ ...c, project_name: null }));
  if (!includeProjects) return chats;
  // The main list leaves out chats filed inside a Project; merge those in
  // (newest first) so a caller is not silently blind to them.
  const p = await dispatchToExtension({ action: "list_project_chats", per_project: Math.min(limit, 100) }, COMMAND_TIMEOUT_MS, { single: true, account });
  const seen = new Set(chats.map((c) => c.id));
  for (const project of p.projects || []) for (const c of project.chats || []) if (!seen.has(c.id)) { seen.add(c.id); chats.push(c); }
  const t = (v) => (typeof v === 'number' ? v * 1000 : Date.parse(v || '') || 0);
  return chats.sort((a, b) => t(b.update_time) - t(a.update_time)).slice(0, limit);
}

// Accepts a bare conversation id or any chatgpt.com conversation URL
// (/c/<id>, or /g/<project>/c/<id> for a chat inside a Project).
function threadIdFromInput(input) {
  const v = String(input || '').trim();
  const fromUrl = v.match(/\/c\/([A-Za-z0-9-]+)/);
  if (fromUrl) return fromUrl[1];
  if (!v || /[\s/]/.test(v)) throw new Error(`"${v}" is not a ChatGPT conversation id or chatgpt.com/c/... link.`);
  return v;
}

// read_chatgpt_chat -------------------------------------------------------------
// Reads a whole conversation (text and images) by id without sending anything.
// With no account given, each connected account is tried in turn, since a
// conversation is only visible to the account that owns it. Images are also
// written to disk so they outlive the tool call.
const IMAGE_DIR = path.join(ARCHIVE_DIR, 'images');
async function readChatgptChat({ thread, account = null, include_images = true, max_images = 40 }) {
  const threadId = threadIdFromInput(thread);
  const command = { action: 'read_conversation', thread_id: threadId, include_images, max_images };
  const targets = account ? [{ key: account, account }] : oneSocketPerAccount().map((t) => ({ key: t.key, tab: t.tab }));
  if (!targets.length) throw new Error('No browser extension is connected to the broker.');
  const errors = [];
  for (const t of targets) {
    try {
      const r = await dispatchToExtension(command, 180000, t.account ? { single: true, account: t.account } : { tab: t.tab });
      const dir = path.join(IMAGE_DIR, threadId);
      const images = (r.images || []).map((img, i) => {
        if (!img.data) return { ...img, path: null };
        fs.mkdirSync(dir, { recursive: true });
        const ext = (String(img.mimeType || 'image/png').split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
        const file = path.join(dir, `${String(i + 1).padStart(2, '0')}-${img.message_id || 'image'}.${ext}`);
        fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
        return { ...img, path: path.resolve(file) };
      });
      return { ...r, images, account: accountKey(r.account) || t.key };
    } catch (err) { errors.push(`${t.key}: ${err.message}`); }
  }
  throw new Error(`Could not read conversation ${threadId} from any connected account (${errors.join(' | ')}).`);
}

function formatChatTranscript(r) {
  const imagesByMessage = new Map();
  for (const img of r.images || []) {
    if (!imagesByMessage.has(img.message_id)) imagesByMessage.set(img.message_id, []);
    imagesByMessage.get(img.message_id).push(img);
  }
  const lines = [`# ${r.title || 'Untitled'}`, `conversation ${r.thread_id} · account ${r.account || 'unknown'}${r.project_id ? ` · project ${r.project_id}` : ''} · https://chatgpt.com/c/${r.thread_id}`];
  if (r.latest_reply_finished === true) lines.push('latest reply: finished');
  if (r.latest_reply_finished === false) lines.push('latest reply: NOT finished -- ChatGPT is still answering (or the last message is the prompt); read again later');
  lines.push('');
  for (const m of r.messages || []) {
    lines.push(`## ${m.role}${m.created_at ? ` (${m.created_at})` : ''}`);
    if (m.text) lines.push(m.text);
    for (const img of imagesByMessage.get(m.message_id) || []) lines.push(img.path ? `[image saved: ${img.path}]` : `[image unavailable: ${img.error || 'no data'}]`);
    lines.push('');
  }
  return lines.join('\n');
}

// Case-insensitive title match: an exact title wins; otherwise every title that
// contains the query. The caller decides what zero or several matches mean.
function matchChatsByTitle(chats, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const exact = chats.filter((c) => (c.title || "").trim().toLowerCase() === q);
  return exact.length ? exact : chats.filter((c) => (c.title || "").toLowerCase().includes(q));
}

async function resolveThreadTitle(title, account = null) {
  const matches = matchChatsByTitle(await listRecentChats(100, { account, includeProjects: true }), title);
  if (matches.length === 1) return matches[0].id;
  if (!matches.length) throw new Error(`No chat among the 100 most recent has a title matching "${title}". Use list_chatgpt_chats or search_archived_chats to find its id.`);
  throw new Error(`"${title}" matches ${matches.length} chats; pass thread_id instead: ${matches.slice(0, 10).map((c) => `${c.id} "${c.title}"`).join("; ")}`);
}

// ask_chatgpt ------------------------------------------------------------------
// Send a message into a ChatGPT conversation through one idle tab and wait
// for the reply. Concurrent asks are allowed as long as each lands on its own
// tab: this set holds the tokens of tabs currently claimed by an in-flight
// ask, checked and set synchronously (no await in between) so two concurrent
// pickIdleTab() calls can never both claim the same tab.
const claimedTabs = new Set();

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

// The account a tab reports on connecting. A freshly opened tab reports it a
// moment after it connects (content.js reportIdentity reads /api/auth/session),
// so wait briefly for it: the 2026-09-29 live check showed a new agent tab's
// first ask still logged account:null without this wait.
async function accountOfTab(tab, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const ws = [...extensionSockets].find((w) => w.tabToken === tab && w.readyState === w.OPEN);
    const key = accountKey(ws?.account);
    if (key || Date.now() >= deadline) return key || null;
    await sleep(200);
  }
}

async function findIdleAgentTab(seen, excludeTokens = new Set(), account = null) {
  const tokens = [...new Set([...extensionSockets]
    .filter((ws) => ws.readyState === ws.OPEN && ws.tabToken && ws.agentTab && !excludeTokens.has(ws.tabToken) && (!account || accountMatches(ws.account, account)))
    .map((ws) => ws.tabToken))];
  for (const tab of tokens) {
    if (claimedTabs.has(tab)) { seen.push({ tab: tab.slice(0, 8), busy: "claimed" }); continue; }
    try {
      const info = await dispatchToExtension({ action: "get_tab" }, 3000, { tab });
      // Re-check after the await: another concurrent call may have claimed
      // this same tab while this dispatch was in flight. The check-and-claim
      // itself is synchronous (no await), so exactly one caller wins it.
      if (claimedTabs.has(tab)) { seen.push({ tab: tab.slice(0, 8), busy: "claimed" }); continue; }
      seen.push({ tab: tab.slice(0, 8), busy: info.busy });
      if (!info.busy) { claimedTabs.add(tab); return { tab, thread_id: info.thread_id || null, account: accountKey(info.account) }; }
    } catch (err) { seen.push({ tab: tab.slice(0, 8), error: err.message }); }
  }
  return null;
}

async function pickIdleTab({ openWaitMs = 90000, forceNew = false, account = null } = {}) {
  const seen = [];
  const existing = new Set([...extensionSockets]
    .filter((ws) => ws.readyState === ws.OPEN && ws.tabToken && ws.agentTab)
    .map((ws) => ws.tabToken));
  if (!forceNew) {
    const found = await findIdleAgentTab(seen, new Set(), account);
    if (found) return found;
  }
  await openAgentTab({ account });
  const deadline = Date.now() + openWaitMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const next = await findIdleAgentTab([], forceNew ? existing : new Set(), account);
    if (next) return next;
  }
  const where = account ? ` signed into ${account} (the broker's open command uses the default browser profile; open ${AGENT_TAB_URL} yourself in the profile signed into that account)` : '';
  throw new Error(`No idle agent ChatGPT tab${where} (${JSON.stringify(seen)}); opened ${AGENT_TAB_URL} but no matching tab connected within ${Math.round(openWaitMs / 1000)}s (is the browser signed in and the extension enabled?).`);
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

// sendPrompt can legitimately spend up to ~99s waiting for a newly navigated
// page, the editor, the send acknowledgement, and ChatGPT's permanent thread
// id. The broker previously killed that command at 90s, before the extension's
// own bounded recovery sequence could finish. Keep this command timeout above
// that internal ceiling while still bounding it independently of model reply
// generation, which is handled by timeout_seconds below.
function promptDispatchTimeoutMs(timeoutSeconds) {
  return Math.max(120000, Math.min((Number(timeoutSeconds) + 30) * 1000, 300000));
}

// A timeout must say exactly what happened, because the caller's natural move
// ("it failed, send it again") duplicates the question whenever the prompt was
// in fact sent -- which is the usual case: a thinking model can take minutes
// even for a one-line prompt, well past a caller's timeout_seconds. So the
// error states whether the send was seen, names the conversation, and points
// at the supported way to collect the late reply (read_chatgpt_chat, which
// reports whether the latest reply is finished) instead of a resend.
function askTimeoutMessage({ timeout_seconds, sendSeen, threadId, last, sent }) {
  const lastSeen = ` (last seen: ${JSON.stringify(last)})`;
  const read = threadId ? `read_chatgpt_chat(thread="${threadId}")` : null;
  if (sendSeen) {
    const where = threadId
      ? `conversation ${threadId} -- https://chatgpt.com/c/${threadId}`
      : 'conversation id not assigned yet -- it will be the newest chat in list_chatgpt_chats';
    return `No finished reply within ${timeout_seconds}s, but the prompt WAS sent and ChatGPT is still answering (${where}). `
      + `Do NOT resend it: that would ask the same question twice. Collect the reply when it lands with ${read || 'read_chatgpt_chat on that conversation'} `
      + `-- its header says "latest reply: finished" once ChatGPT is done -- or allow a larger timeout_seconds (up to 900) next time.${lastSeen}`;
  }
  return `Could not confirm the prompt was sent: Send was clicked, but within ${timeout_seconds}s no new message, conversation id, or reply appeared `
    + `(tab visibility=${sent?.visibility || 'unknown'}). It may or may not have reached ChatGPT. Before resending, check `
    + `${read || 'list_chatgpt_chats for a new chat'} so the question is not asked twice.${lastSeen}`;
}

// A get_reply result for a thread with a real id that carries no evidence
// about completion: the extension skipped its API read (cooldown) or the read
// failed (e.g. HTTP 429), and ChatGPT is not visibly generating.
function pollLearnedNothing(poll) {
  return poll.source === "api_waiting" && !poll.generating && (!poll.api_checked || poll.api_status != null);
}

// Conversations already handed to an ask (in flight or answered). The
// extension's server-side search for an unconfirmed new chat skips these, so
// two asks with identical text never claim the same conversation. Bounded.
const attributedThreads = new Set();
function noteAttributedThread(id) {
  if (!id) return;
  attributedThreads.delete(id);
  attributedThreads.add(id);
  while (attributedThreads.size > 500) attributedThreads.delete(attributedThreads.values().next().value);
}

async function askChatgpt({ text, thread_id = null, thread_title = null, timeout_seconds = 180, pollMs = 3000, openWaitMs = 90000, sendTimeoutMs = null, fresh_tab = false, account = null, confirmGraceMs = 75000 }) {
  const run = async () => {
    const body = String(text || "").trim();
    if (!body) throw new Error("text is required.");
    if (thread_id && thread_title) throw new Error("pass thread_id or thread_title, not both.");
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    let last = null;
    let resolvedThreadId = thread_id;
    let conversationMode = thread_id || thread_title ? 'continuing' : 'new';
    let claimedTab = null;
    let usedAccount = account;
    let sendSeen = null;
    let sentThreadId = null;
    try {
      if (thread_id) resolvedThreadId = threadIdFromInput(thread_id);
      if (thread_title) resolvedThreadId = await resolveThreadTitle(thread_title, account);
      const picked = await pickIdleTab({ openWaitMs, forceNew: fresh_tab, account });
      const { tab, thread_id: current } = picked;
      claimedTab = tab;
      // Pace and log under the account the tab is actually signed into, even
      // when the caller named none (issue #28: every audit send was logged
      // account:null and shared the default pacer bucket).
      if (!account) account = picked.account || await accountOfTab(tab);
      usedAccount = account;
      const onTargetPage = (i) => (resolvedThreadId ? i.thread_id === resolvedThreadId : !i.thread_id);
      // Loading a conversation page makes ChatGPT fetch that conversation --
      // a real request on the account -- so the pacer's gap is waited out
      // BEFORE navigating, not between the page load and the send. Both
      // 2026-09-27 "no composer" failures navigated 10-13s after an HTTP 429
      // and then sat ~2 min in the pacer on a page that never showed a
      // composer. The send below then needs no second wait.
      if (current !== resolvedThreadId) await waitForPacerGap(account);
      if (resolvedThreadId && current !== resolvedThreadId) {
        await dispatchToExtension({ action: "navigate_to_thread", thread_id: resolvedThreadId }, COMMAND_TIMEOUT_MS, { tab });
        await waitForTab(tab, (i) => i.thread_id === resolvedThreadId, 20000, `opened conversation ${resolvedThreadId}`);
      } else if (!resolvedThreadId && current) {
        await dispatchToExtension({ action: "navigate_home" }, COMMAND_TIMEOUT_MS, { tab });
        await waitForTab(tab, (i) => !i.thread_id, 20000, "opened a new chat");
      }
      const sendPrompt = () => dispatchToExtension(
        { action: "send_prompt", text: body, exclude_threads: [...attributedThreads] },
        sendTimeoutMs ?? promptDispatchTimeoutMs(timeout_seconds),
        { tab, account },
      );
      let sent;
      try {
        try {
          sent = await sendPrompt();
        } catch (err) {
          // The composer never appeared on this page (observed 2026-09-27 on
          // continuation pages that had been loaded for ~2 minutes; they do
          // not recover by themselves). The extension throws that before
          // typing anything and says so (nothing_sent, content.js
          // sendPrompt), so one reload of that tab and one more send cannot
          // duplicate the prompt. Only that explicit, per-page report is
          // retried -- never a timeout or a failure after typing began -- and
          // not when ChatGPT's rate-limit banner is up (a reload would be one
          // more request into the throttle).
          //
          // A continuation whose pre-send conversation read failed (usually
          // HTTP 429) is refused the same way (stage no_baseline): without
          // that count the reply cannot be told apart from earlier turns. It
          // is retried once after the pacer gap, which that 429 has widened;
          // no reload is needed.
          const recoverable = err.nothing_sent === true && err.page_id && (err.stage === 'no_composer' || err.stage === 'no_baseline');
          if (!recoverable) throw err;
          const nothingSent = 'Nothing was typed or sent, so the ask can be retried safely later.';
          if (err.stage === 'no_composer' && err.visible_error === 'too_many_requests') {
            throw Object.assign(new Error(`${err.message} ChatGPT is showing its rate-limit banner ("making requests too quickly") in that tab, so it was not reloaded. ${nothingSent}`), { nothing_sent: true });
          }
          await waitForPacerGap(account);
          if (err.stage === 'no_composer') {
            appendRequestTiming({ action: 'reload_for_composer', ok: true, tab: tab.slice(0, 8), page_id: err.page_id, ...recordAndCountWindow(Date.now()) });
            // Not awaited: the page may unload before its reply crosses the
            // socket. The new page instance reporting in is the real signal.
            dispatchToExtension({ action: "reload_tab" }, 5000, { tab }).catch(() => {});
            await waitForTab(tab, (i) => Boolean(i.page_id) && i.page_id !== err.page_id && onTargetPage(i), 20000, "reloaded the conversation page")
              .catch((reloadErr) => { throw Object.assign(new Error(`${err.message} Reloading the tab to recover failed: ${reloadErr.message} ${nothingSent}`), { nothing_sent: true }); });
          }
          try {
            sent = await sendPrompt();
          } catch (retryErr) {
            if (retryErr.nothing_sent === true && (retryErr.stage === 'no_composer' || retryErr.stage === 'no_baseline')) {
              const tried = err.stage === 'no_composer' ? 'reloaded the tab once' : 'retried once after the rate-limit gap';
              throw Object.assign(new Error(`${retryErr.message} The broker ${tried} and it failed again. ${nothingSent}`), { nothing_sent: true });
            }
            throw retryErr;
          }
        }
      } catch (err) {
        // Submitting the first message can navigate the new-chat page and tear
        // down its content script before the command result crosses the socket.
        // The tab token survives that navigation. If the same tab now has a
        // real thread id, the send happened; recover that identity and poll the
        // answer instead of falsely failing (and tempting callers to duplicate
        // the prompt). This recovery is intentionally new-thread-only.
        if (conversationMode !== 'new' || !/Timed out waiting for the browser extension/i.test(err.message)) throw err;
        const currentTab = await dispatchToExtension({ action: "get_tab" }, 5000, { tab });
        if (!currentTab.thread_id) throw err;
        sent = { thread_id: currentTab.thread_id, dom_before: 0, messages_before: 0, recovered_after_navigation: true };
      }
      // The extension reports send_confirmed:false when Send was clicked but no
      // consequence was observable yet (typically a hidden tab: see
      // extension/lib/send-confirm.js). That prompt may well be with ChatGPT,
      // so keep watching the thread instead of failing; any later sign of the
      // turn (a conversation id for a new chat, generation, a new message)
      // confirms it. An older extension omits the field: treat as confirmed,
      // which is what its successful send_prompt meant.
      sendSeen = sent.send_confirmed !== false;
      sentThreadId = sent.thread_id || resolvedThreadId || null;
      noteAttributedThread(sentThreadId);
      const noteSendEvidence = (poll) => {
        if (sendSeen || !poll) return;
        if (poll.done || poll.generating || (conversationMode === 'new' && poll.thread_id)
          || (Number.isInteger(poll.message_count) && poll.message_count > (Number(sent.dom_before) || 0))) sendSeen = true;
      };
      const deadline = Date.now() + timeout_seconds * 1000;
      let previousDoneText = null;
      // A finished reply needs two agreeing reads to rule out a mid-stream
      // pause or an intermediate message -- unless ChatGPT's own conversation
      // tree marks it end_turn, which is the backend saying the turn is over.
      // If the FIRST of two reads lands right at the deadline, the confirming
      // read must still run instead of reporting a timeout despite already
      // having the answer (observed live 2026-09-17), so once a done candidate
      // is seen, confirmation may run past the deadline -- bounded by
      // confirmGraceMs, which covers the extension's backed-off API-read gap.
      let confirmUntil = 0;
      while (Date.now() < deadline || Date.now() < confirmUntil) {
        await sleep(pollMs);
        try { last = await dispatchToExtension({ action: "get_reply", dom_before: sent.dom_before, messages_before: sent.messages_before, expected: body, thread_hint: sentThreadId, exclude_threads: [...attributedThreads] }, 30000, { tab, account }); }
        catch (err) { last = { done: false, error: err.message }; continue; }
        if (last.discovered_thread_id && !sentThreadId) {
          // Found server-side: the send landed although the page never showed it.
          sentThreadId = last.discovered_thread_id;
          noteAttributedThread(sentThreadId);
          sendSeen = true;
        }
        noteSendEvidence(last);
        if (last.prompt_mismatch) {
          // The extension found a different prompt where ours should be. Its
          // answer is not ours; fail now instead of returning it (the old
          // behaviour) or waiting out the timeout.
          throw Object.assign(new Error(`Refusing to return a reply: conversation ${last.thread_id} does not contain this prompt as its new turn `
            + `(found a ${last.found_prompt_chars}-character prompt starting "${last.found_prompt_head}"). Something other than this ask sent into that conversation. `
            + `Whether this prompt reached ChatGPT is unknown; check list_chatgpt_chats before resending.`), { sent_unknown: true });
        }
        if (!last.done) {
          // Only a read that actually observed "not finished" discards a done
          // candidate. Between two API reads the extension answers from the
          // page alone (api_checked:false), and a throttled read (HTTP 429)
          // learns nothing either; treating those as "not done" meant two
          // consecutive done polls never happened and every ask waited out
          // its full timeout with the answer in hand (2026-09-26/27).
          if (!pollLearnedNothing(last)) { previousDoneText = null; confirmUntil = 0; }
          continue;
        }
        const authoritative = last.source === "api" && last.end_turn === true;
        if (!authoritative && last.reply !== previousDoneText) {
          previousDoneText = last.reply;
          confirmUntil = Date.now() + confirmGraceMs;
          continue;
        }
        const threadId = last.thread_id || sentThreadId || resolvedThreadId || null;
        noteAttributedThread(threadId);
        appendBridgeObservation({ started_at: startedAt, ended_at: new Date().toISOString(), duration_ms: Date.now() - startedMs, outcome: 'success', account: usedAccount || null, failure_kind: null, visible_error: null, conversation_mode: conversationMode, thread_id: threadId, prompt_chars: body.length, history_message_count: Number.isInteger(last.message_count) ? last.message_count : null, history_chars: null, thinking_level: 'unknown' });
        return { thread_id: threadId, url: threadId ? `https://chatgpt.com/c/${threadId}` : null, reply: last.reply, images: last.images, account: usedAccount || null };
      }
      throw new Error(askTimeoutMessage({ timeout_seconds, sendSeen, threadId: last?.thread_id || sent.thread_id || resolvedThreadId || null, last, sent }));
    } catch (err) {
      err.sent = err.sent_unknown ? null : err.nothing_sent ? false : sendSeen;
      err.thread_id = last?.thread_id || sentThreadId || resolvedThreadId || null;
      err.account = usedAccount || null;
      appendBridgeObservation({ started_at: startedAt, ended_at: new Date().toISOString(), duration_ms: Date.now() - startedMs, outcome: 'failed', account: usedAccount || null, sent: err.sent, failure_kind: bridgeFailureKind(err, last), visible_error: last?.visible_error || null, error_message: String(err?.message || '').replace(/ \(last seen: .*$/s, '').slice(0, 300), conversation_mode: conversationMode, thread_id: last?.thread_id || resolvedThreadId || null, prompt_chars: body.length, history_message_count: Number.isInteger(last?.message_count) ? last.message_count : null, history_chars: null, thinking_level: 'unknown' });
      throw err;
    } finally {
      if (claimedTab) claimedTabs.delete(claimedTab);
    }
  };
  return run();
}

app.post("/api/ask", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: "unauthorized" });
  // sent: true (the prompt reached ChatGPT; collect the reply, do not
  // resend), false (it did not; retrying is safe), null (unknown).
  try { res.json(await askChatgpt(req.body || {})); }
  catch (err) { res.status(503).json({ error: err.message, sent: err.sent ?? null, thread_id: err.thread_id ?? null, account: err.account ?? null }); }
});

app.get("/health", (_req, res) => res.json({ ok: true, extension_connections: extensionSockets.size, archive_dir: ARCHIVE_DIR, extension_version: extensionVersionOnDisk(),
  // What the connected tabs actually run (null: older than 0.7.4). Differs
  // from extension_version until Chrome reloads the extension.
  extension_versions_running: [...new Set([...extensionSockets].filter((ws) => ws.readyState === ws.OPEN).map((ws) => ws.extensionVersion || null))],
  // Whether each tab's ping reached the extension's background worker, the
  // only thing that can reload the extension (false: it cannot auto-update
  // until reloaded by hand; null: not reported, tab older than 0.7.6).
  extension_background_ok: [...new Set([...extensionSockets].filter((ws) => ws.readyState === ws.OPEN).map((ws) => ws.backgroundOk ?? null))] }));
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
// Temporary, read-only reconnaissance endpoint for adding thinking-level
// control -- see the matching debug_inspect_toolbar action in content.js.
// Not documented, not an MCP tool; remove once the real picker is found.
app.post('/api/debug/inspect-toolbar', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try { res.json(await dispatchToExtension({ action: 'debug_inspect_toolbar' }, COMMAND_TIMEOUT_MS, { single: true })); }
  catch (err) { res.status(503).json({ error: err.message }); }
});
app.post('/api/debug/click-and-inspect', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try { res.json(await dispatchToExtension({ action: 'debug_click_and_inspect', text: req.body?.text }, COMMAND_TIMEOUT_MS, { single: true })); }
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
// Read any conversation the signed-in account owns (text + generated images,
// images saved under data/images/<thread>/) without sending anything -- the
// REST twin of the read_chatgpt_chat MCP tool, for callers that only have curl.
app.get('/api/read/:thread', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const r = await readChatgptChat({
      thread: req.params.thread,
      account: req.query.account || null,
      include_images: req.query.include_images !== 'false',
      max_images: req.query.max_images ? Number(req.query.max_images) : 40,
    });
    res.json({ ...r, images: (r.images || []).map(({ data, ...rest }) => rest), transcript: formatChatTranscript(r) });
  } catch (err) { res.status(503).json({ error: err.message }); }
});
app.get('/api/thread/:id', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.query.full === '1') {
    const snapshot = archive.getThread(req.params.id);
    if (!snapshot) return res.status(404).json({ error: `Unknown archived thread: ${req.params.id}` });
    return res.json(snapshot);
  }
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

  mcp.tool('ask_chatgpt', 'Send a message to ChatGPT in Brian\'s own logged-in browser and return its reply. Omit thread_id and thread_title to start a new chat; pass a conversation id, or a title that matches exactly one of the 100 most recent chats, to continue that conversation (a chatgpt.com/c/... link also works as thread_id). Pass account (email) to use an agent tab signed into that ChatGPT account; see list_chatgpt_connections. Types only into the dedicated agent tab (https://chatgpt.com/?ccm_agent=1, opened automatically), never into a tab Brian is using, and waits up to timeout_seconds for the reply to finish. Several calls may run at once (each claims its own agent tab). If the reply is not finished in time the error says whether the prompt was sent and names the conversation: do not resend then -- collect the late reply with read_chatgpt_chat on that conversation (it reports whether the latest reply is finished). Thinking models can take minutes even for short prompts, so prefer a generous timeout_seconds.', {
    text: z.string().min(1),
    thread_id: z.string().optional(),
    thread_title: z.string().min(1).optional(),
    timeout_seconds: z.number().int().min(10).max(900).optional(),
    fresh_tab: z.boolean().optional(),
    account: z.string().min(1).optional(),
  }, async ({ text, thread_id, thread_title, timeout_seconds, fresh_tab, account }) => {
    try {
      const r = await askChatgpt({ text, thread_id: thread_id || null, thread_title: thread_title || null, timeout_seconds: timeout_seconds || 180, fresh_tab: Boolean(fresh_tab), account: account || null });
      const content = [{ type: 'text', text: `${r.reply}\n\n[conversation ${r.thread_id} — ${r.url}${r.account ? ` — account ${r.account}` : ''}]` }];
      // Images ChatGPT generated or returned inline (see extension/lib/api-capture.js
      // resolveFileDownloadUrl and content.js resolveReplyImages) arrive already
      // resolved to inline base64 -- nothing downstream of the extension can
      // dereference a ChatGPT tab-scoped URL, so this must stay data, not a link.
      if (Array.isArray(r.images)) {
        for (const img of r.images) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
      }
      return { content };
    } catch (err) {
      // One fixed, parseable status line so a caller can act without reading
      // prose: sent=yes -> collect the reply, never resend; sent=no -> safe to
      // retry; sent=unknown -> check the conversation list first.
      const sent = err.sent === true ? 'yes' : err.sent === false ? 'no' : 'unknown';
      return { isError: true, content: [{ type: 'text', text: `ask_chatgpt failed: ${err.message}\n\n[sent=${sent} conversation=${err.thread_id || 'none'} account=${err.account || 'unknown'}]` }] };
    }
  });

  mcp.tool('reload_chatgpt_tabs', 'Hard-refresh every currently-connected ChatGPT tab (Brian\'s own tabs and any dedicated agent tab). Use this ONLY after Brian has already reloaded the extension itself in chrome://extensions -- that step cannot be done remotely, this tool cannot trigger it, and refreshing tabs before it happens just reloads the same old code. Fire-and-forget: each tab tears its page down the instant it reloads, so this does not wait for or confirm success -- verify the new code actually landed with a fresh call afterward (e.g. ask_chatgpt with a distinguishing marker), not by trusting this tool\'s own reply.', {}, async () => {
    try {
      const result = broadcastReloadTab();
      return { content: [{ type: 'text', text: `Sent a reload command to ${result.sent_to} connected tab(s). Give Chrome a few seconds to reconnect, then verify with a fresh call.` }] };
    } catch (err) { return { isError: true, content: [{ type: 'text', text: `reload_chatgpt_tabs failed: ${err.message}` }] }; }
  });

  mcp.tool('list_chatgpt_connections', 'List every ChatGPT browser tab currently connected to the bridge, with the ChatGPT account each is signed into and whether it is an agent tab. Use it to see which accounts you can read from or send to. A chat started anywhere (another browser, the desktop app, a phone) is readable through any connected tab signed into the same account.', {}, async () => {
    const rows = listConnections();
    const text = rows.length ? rows.map((r) => `tab ${r.tab}  ${r.agent ? 'agent' : 'human'}  account ${r.account || '(not reported yet)'}${r.plan ? `  [${r.plan}]` : ''}  extension ${r.extension_version || 'older than 0.7.4'}${r.extension_version === extensionVersionOnDisk() ? '' : ` (on disk: ${extensionVersionOnDisk()}; not reloaded yet)`}`).join('\n') : 'No ChatGPT tabs are connected. Open https://chatgpt.com in a browser profile with the bridge extension installed.';
    return { content: [{ type: 'text', text }] };
  });

  mcp.tool('read_chatgpt_chat', 'Read an entire ChatGPT conversation -- every message plus any generated or uploaded images -- by id or chatgpt.com link, WITHOUT sending anything into it. Works for any chat the signed-in account owns, wherever it was started (desktop app, another browser, inside a Project). Images are saved to disk (paths in the transcript) and, when inline_images is true, also returned inline. Omit account to try every connected account.', {
    thread: z.string().min(1),
    account: z.string().min(1).optional(),
    include_images: z.boolean().optional(),
    inline_images: z.boolean().optional(),
    max_images: z.number().int().min(0).max(200).optional(),
  }, async ({ thread, account, include_images, inline_images, max_images }) => {
    try {
      const r = await readChatgptChat({ thread, account: account || null, include_images: include_images !== false, max_images: max_images ?? 40 });
      const content = [{ type: 'text', text: formatChatTranscript(r) }];
      if (inline_images !== false) for (const img of r.images || []) if (img.data) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
      return { content };
    } catch (err) { return { isError: true, content: [{ type: 'text', text: `read_chatgpt_chat failed: ${err.message}` }] }; }
  });

  mcp.tool('list_chatgpt_chats', 'List Brian\'s most recent ChatGPT chats live from ChatGPT (newest first): id, title, last updated, and project. Includes chats filed inside Projects unless include_projects is false. Optional query filters by title; optional account (email) picks which signed-in account to list. Use the id with read_chatgpt_chat to read a chat or ask_chatgpt to continue it. For older chats or searching message text, use search_archived_chats.', {
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    account: z.string().min(1).optional(),
    include_projects: z.boolean().optional(),
  }, async ({ query, limit, account, include_projects }) => {
    try {
      let chats = await listRecentChats(query ? 100 : (limit || 28), { account: account || null, includeProjects: include_projects !== false });
      if (query) chats = matchChatsByTitle(chats, query).slice(0, limit || 28);
      const text = chats.length ? chats.map((c) => `${c.id}  ${c.title || '(untitled)'}${c.project_name ? `  {project: ${c.project_name}}` : ''}  [updated ${c.update_time ?? 'unknown'}]`).join('\n') : (query ? `No recent chat title matches "${query}".` : 'No chats returned.');
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
    logInfo(`Conversation manager listening on http://localhost:${PORT}`);
    logInfo(`Archive: ${ARCHIVE_DIR}`);
    logInfo(`MCP:     http://localhost:${PORT}/mcp`);
    if (SYNC_INTERVAL_MINUTES > 0) {
      sync.start(SYNC_INTERVAL_MINUTES * 60 * 1000);
      logInfo(`Sync:    incremental backup every ${SYNC_INTERVAL_MINUTES} min (status: GET /api/sync-status)`);
    }
  });
}

export { readChatgptChat, listRecentChats, listConnections, threadIdFromInput, formatChatTranscript, app, server, archive, sync, askChatgpt, waitForBulkComplete, setAgentTabOpener, matchChatsByTitle, runOpenCommand, promptDispatchTimeoutMs, BRIDGE_OBSERVATIONS_PATH, REQUEST_TIMING_PATH, DOM_ACTIVITY_PATH, agentPacer, getPacerEntry, dispatchToExtension, broadcastReloadTab };
