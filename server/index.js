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
// Loopback only unless HOST says otherwise: anyone who can reach this port and
// knows the token can type into your ChatGPT account.
const HOST = process.env.HOST || "127.0.0.1";
// server.log's own console lines had no timestamps, making it impossible to
// correlate broker activity (tab connects, sync/archive outcomes) against
// timed data like request-timing.jsonl when reconstructing an incident after
// the fact (2026-09-18: asked to explain a rate-limit spike against Brian's
// own concurrent usage and could not line the two up in time).
// Durations, deadlines and pacing use a monotonic clock. The wall clock can
// step: on Brian's WSL machine it jumped forward about 3.6 s every ~30 s
// (measured 2026-09-29: 21.5 s of drift corrected in 3 minutes). With
// Date.now() those steps cut timeouts and pacer gaps short, and made a timing
// test fail about 1 run in 6. Timestamps written to logs still use new Date().
const monoNow = () => performance.now();
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
// A bulk archive has one durable destination, so it must stay bound to the
// intended ChatGPT identity when multiple accounts are connected.
const SYNC_ACCOUNT = process.env.SYNC_ACCOUNT?.trim() || null;
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
  if (error?.rate_limited_load) return 'rate_limited';
  if (/^Could not confirm the prompt was sent/.test(String(error?.message || ''))) return 'send_unconfirmed';
  if (/^Refusing to return a reply/.test(String(error?.message || ''))) return 'attribution_mismatch';
  if (/No finished reply within|Timed out waiting/i.test(String(error?.message || ''))) return 'timeout';
  // Send-step failures the extension raises before anything was sent.
  if (/no ChatGPT composer found|no enabled send button found|prompt text did not appear in the composer|composer did not end up holding exactly this prompt|refusing to click Send|could not put the prompt into ChatGPT's composer/i.test(String(error?.message || ''))) return 'browser_ui';
  if (/^ChatGPT tab never (opened|reloaded)/.test(String(error?.message || ''))) return 'navigation';
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
const API_REQUEST_ENDPOINT_CLASSES = new Set(['auth_session', 'conversation', 'conversation_list', 'project_sidebar', 'file_download', 'backend_other', 'api_other']);
// Broker actions that can cause ChatGPT backend traffic. These are logical
// actions, not a count of each HTTP request; Resource Timing observations below
// record physical same-origin API requests separately.
const PACING_SEQUENCE_ACTIONS = new Set(['navigate_home', 'navigate_to_thread', 'reload_tab']);
const BACKEND_TOUCHING_ACTIONS = new Set(['send_prompt', 'get_reply', 'retry_send_click', 'list_recent_chats', 'list_project_chats', 'read_conversation', 'capture_current_chat', 'move_to_project', 'rename_current_chat', 'open_agent_tab', ...PACING_SEQUENCE_ACTIONS]);

// One pacer per ChatGPT account, not one global pacer, so a rate-limit signal
// on one account's quota does not throttle every other connected account too
// (found 2026-09-25: a single shared agentPacer meant adding a second account
// for load-spreading or team sharing would have undermined its own point --
// see CHANGELOG v0.9.19). `agentPacer` below stays a plain AdaptivePacer for
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
  // Pacer entries are initialized lazily after restart. Keep saved state for
  // accounts that have not made a request in this process; otherwise the first
  // save from another account erases their learned cooldown.
  const out = { ..._savedPacerStateByKey };
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
  entry = { pacer, lastRequestAt: -Infinity, actionTail: Promise.resolve(), actionInFlight: false, apiCheckReservation: null };
  accountPacers.set(key, entry);
  return entry;
}
const agentPacer = getPacerEntry(DEFAULT_PACER_KEY).pacer;
// How many paced broker actions are waiting on or executing at once -- a
// direct measure of orchestration concurrency, independent of the minimum gap.
let agentRequestsInFlight = 0;
// Broker action rates and observed HTTP request rates are separate metrics:
// each action can cause several HTTP requests, and normal ChatGPT page traffic
// also reaches the same account's quota.
const REQUEST_WINDOW_MS = 5 * 60 * 1000;
const MAX_OBSERVED_API_REQUEST_AGE_FOR_COUNTS_MS = REQUEST_WINDOW_MS;
const OBSERVED_API_REQUEST_COUNT_RETENTION_MS = MAX_OBSERVED_API_REQUEST_AGE_FOR_COUNTS_MS + REQUEST_WINDOW_MS;
const recentAgentRequestTimestamps = [];
const recentAgentRequestTimestampsByAccount = new Map();
const agentRequestsInFlightByAccount = new Map();
// Physical same-origin API requests observed by the content script's Resource
// Timing observer. Keep these separate from broker action counts below: one
// broker action can produce several HTTP requests, and the ChatGPT page also
// makes requests the broker did not initiate.
const recentObservedApiEventTimestamps = [];
const recentObservedApiEventTimestampsByAccount = new Map();
function recordAndCountWindow(nowMs, account) {
  recentAgentRequestTimestamps.push(nowMs);
  recentAgentRequestTimestamps.sort((a, b) => a - b);
  const cutoff = nowMs - REQUEST_WINDOW_MS;
  while (recentAgentRequestTimestamps.length && recentAgentRequestTimestamps[0] < cutoff) recentAgentRequestTimestamps.shift();
  const last60s = recentAgentRequestTimestamps.filter((t) => t >= nowMs - 60000).length;
  const key = normalizePacerKey(account);
  let accountTimes = recentAgentRequestTimestampsByAccount.get(key);
  if (!accountTimes) { accountTimes = []; recentAgentRequestTimestampsByAccount.set(key, accountTimes); }
  accountTimes.push(nowMs);
  accountTimes.sort((a, b) => a - b);
  while (accountTimes.length && accountTimes[0] < cutoff) accountTimes.shift();
  const accountLast60s = accountTimes.filter((t) => t >= nowMs - 60000).length;
  return {
    broker_actions_last_60s: last60s,
    broker_actions_last_300s: recentAgentRequestTimestamps.length,
    account_broker_actions_last_60s: accountLast60s,
    account_broker_actions_last_300s: accountTimes.length,
  };
}

function recordAndCountObservedApiEvents(requestStartedAtMono, account, receivedAtMono, requestAgeAtSendMs) {
  recentObservedApiEventTimestamps.push(requestStartedAtMono);
  recentObservedApiEventTimestamps.sort((a, b) => a - b);
  const retentionCutoff = receivedAtMono - OBSERVED_API_REQUEST_COUNT_RETENTION_MS;
  while (recentObservedApiEventTimestamps.length && recentObservedApiEventTimestamps[0] < retentionCutoff) recentObservedApiEventTimestamps.shift();
  let accountTimes = null;
  if (account) {
    const key = normalizePacerKey(account);
    accountTimes = recentObservedApiEventTimestampsByAccount.get(key);
    if (!accountTimes) { accountTimes = []; recentObservedApiEventTimestampsByAccount.set(key, accountTimes); }
    accountTimes.push(requestStartedAtMono);
    accountTimes.sort((a, b) => a - b);
    while (accountTimes.length && accountTimes[0] < retentionCutoff) accountTimes.shift();
  }
  const countWindowWithinRetention = requestAgeAtSendMs <= MAX_OBSERVED_API_REQUEST_AGE_FOR_COUNTS_MS;
  return {
    request_count_window_status: countWindowWithinRetention ? 'age_within_retention' : 'age_exceeds_retention',
    request_count_window_max_age_ms: MAX_OBSERVED_API_REQUEST_AGE_FOR_COUNTS_MS,
    observed_api_requests_started_last_60s: countWindowWithinRetention
      ? recentObservedApiEventTimestamps.filter((t) => t >= requestStartedAtMono - 60000 && t <= requestStartedAtMono).length
      : null,
    observed_api_requests_started_last_300s: countWindowWithinRetention
      ? recentObservedApiEventTimestamps.filter((t) => t >= requestStartedAtMono - REQUEST_WINDOW_MS && t <= requestStartedAtMono).length
      : null,
    account_observed_api_requests_started_last_60s: countWindowWithinRetention && accountTimes
      ? accountTimes.filter((t) => t >= requestStartedAtMono - 60000 && t <= requestStartedAtMono).length
      : null,
    account_observed_api_requests_started_last_300s: countWindowWithinRetention && accountTimes
      ? accountTimes.filter((t) => t >= requestStartedAtMono - REQUEST_WINDOW_MS && t <= requestStartedAtMono).length
      : null,
  };
}

function requestStartFromResult(action, result, fallbackIso, fallbackMono, fallbackWallMs) {
  const candidate = action === 'get_reply' ? result?.api_request_started_at
    : ['send_prompt', 'retry_send_click'].includes(action) ? result?.sent_at : null;
  const timestamp = typeof candidate === 'string' ? Date.parse(candidate) : NaN;
  const mono = Number.isFinite(timestamp)
    ? fallbackMono + Math.max(0, timestamp - fallbackWallMs)
    : fallbackMono;
  return { at: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallbackIso, mono };
}

function appendRequestTiming(event) {
  fs.mkdirSync(path.dirname(REQUEST_TIMING_PATH), { recursive: true });
  fs.appendFileSync(REQUEST_TIMING_PATH, `${JSON.stringify({ schema_version: event.schema_version ?? 1, ts: new Date().toISOString(), ...event })}\n`);
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
  ws.connectedAtMono = monoNow();
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
    if (msg?.type === 'api_request_observer_status') {
      appendRequestTiming({ schema_version: 2, event_type: 'observer_status', action: 'api_request_observer_status',
        available: msg.available === true, account: accountKey(ws.account), tab: ws.tabToken?.slice(0, 8) ?? null, agent_tab: ws.agentTab ?? null });
      return;
    }
    if (msg?.type === 'api_request_observed') {
      const receivedAtWallMs = Date.now();
      const receivedAtMono = monoNow();
      const requestAgeAtSendMs = msg.request_age_ms;
      const durationMs = msg.duration_ms;
      const apiStatus = Number.isInteger(msg.api_status) && msg.api_status >= 100 && msg.api_status <= 599 ? msg.api_status : null;
      if (msg.source !== 'performance_resource_timing' || !API_REQUEST_ENDPOINT_CLASSES.has(msg.endpoint_class)
          || !Number.isFinite(requestAgeAtSendMs) || requestAgeAtSendMs < 0
          || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 24 * 60 * 60 * 1000) return;
      const startedAtMs = receivedAtWallMs - requestAgeAtSendMs;
      const completedAtMs = startedAtMs + durationMs;
      const dateLimitMs = 8.64e15;
      if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)
          || Math.abs(startedAtMs) > dateLimitMs || Math.abs(completedAtMs) > dateLimitMs) return;
      const requestStartedAtMono = receivedAtMono - requestAgeAtSendMs;
      if (!Number.isFinite(requestStartedAtMono)) return;
      const account = accountKey(ws.account);
      appendRequestTiming({
        schema_version: 3, event_type: 'api_request', action: 'chatgpt_api_request',
        source: msg.source, endpoint_class: msg.endpoint_class,
        request_started_at: new Date(startedAtMs).toISOString(), completed_at: new Date(completedAtMs).toISOString(),
        request_age_at_send_ms: Math.round(requestAgeAtSendMs), broker_received_at: new Date(receivedAtWallMs).toISOString(),
        timing_basis: 'broker_receipt_minus_page_monotonic_age', request_count_window_reference: 'request_started_at',
        duration_ms: Math.round(durationMs), api_status: apiStatus, rate_limited: apiStatus === 429,
        initiator_type: typeof msg.initiator_type === 'string' && /^[a-z0-9_-]{1,32}$/i.test(msg.initiator_type) ? msg.initiator_type : null,
        account, tab: ws.tabToken?.slice(0, 8) ?? null, agent_tab: ws.agentTab ?? null,
        ...recordAndCountObservedApiEvents(requestStartedAtMono, account, receivedAtMono, requestAgeAtSendMs),
      });
      return;
    }
    if (msg?.type === 'api_request_observation_gap') {
      const dropped = msg.dropped;
      if (Number.isInteger(dropped) && dropped > 0) {
        appendRequestTiming({ schema_version: 2, event_type: 'telemetry_gap', action: 'api_request_observation_gap', dropped,
          account: accountKey(ws.account), tab: ws.tabToken?.slice(0, 8) ?? null, agent_tab: ws.agentTab ?? null });
      }
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
        schema_version: 2, event_type: 'capture_snapshot', action: 'auto_capture', ok: true, rate_limited: autoCaptureRateLimited, api_status: msg.api_error_status ?? null,
        account: autoCapturePacerKey === DEFAULT_PACER_KEY ? null : autoCapturePacerKey,
        tab: ws.tabToken?.slice(0, 8) ?? null, agent_tab: ws.agentTab ?? null, spacing_ms: getPacerEntry(autoCapturePacerKey).pacer.spacingMs,
      });
      try { const saved = archive.archiveSnapshot(msg.snapshot, { account: accountKey(ws.account) }); ws.send(JSON.stringify({ type: 'snapshot_ack', thread_id: saved.thread_id, content_hash: saved.content_hash })); }
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
  // These three refusals happen before the command leaves the broker, so the
  // tab did nothing (not_dispatched): askChatgpt uses that to report sent=no.
  const refuse = (message) => Object.assign(new Error(message), { not_dispatched: true });
  if (!sockets.length) throw refuse("No browser extension is connected to the broker.");
  if (command.action === 'archive_all_chats' && !account) {
    const identities = sockets.map((ws) => accountKey(ws.account));
    const knownAccounts = new Set(identities.filter(Boolean).map((value) => value.toLowerCase()));
    if (identities.some((value) => !value) || knownAccounts.size > 1) {
      throw refuse('Bulk archive requires an explicit account when connected tabs have ambiguous identities. Set SYNC_ACCOUNT to the intended account and restart the broker.');
    }
  }
  if (account) {
    sockets = sockets.filter((ws) => accountMatches(ws.account, account));
    if (!sockets.length) throw refuse(noAccountTabMessage(account));
  }
  if (tab) {
    sockets = sockets.filter((ws) => ws.tabToken === tab);
    if (!sockets.length) throw Object.assign(refuse(`ChatGPT tab ${tab.slice(0, 8)} is not connected (closed, or still reloading).`), { tab_dead: true });
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
          api_status: msg.api_status, api_retry_after_ms: msg.api_retry_after_ms, api_limit_detail: msg.api_limit_detail,
          // send_prompt's pre-typing failures (content.js sendPrompt): which
          // step failed, that nothing was typed, which page instance it was,
          // and whether ChatGPT's rate-limit banner was showing.
          stage: msg.stage, nothing_sent: msg.nothing_sent, page_id: msg.page_id, visible_error: msg.visible_error, lifecycle: msg.lifecycle, fill_detail: msg.fill_detail, rendered_messages: msg.rendered_messages, conversation_fetch: msg.conversation_fetch,
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
// get_reply polls stay responsive, but the extension receives an account-wide
// API-check permit so concurrent tabs cannot each spend the same account gap.
// These actions always reserve the account lane before dispatch.
const ALWAYS_REAL_ACTIONS = new Set(['send_prompt', 'retry_send_click', 'list_recent_chats', 'list_project_chats', 'read_conversation', 'capture_current_chat', 'move_to_project', 'rename_current_chat', 'open_agent_tab']);

// Waits out the account's current pacer gap without recording a request.
async function waitForPacerGap(account) {
  const entry = getPacerEntry(normalizePacerKey(account));
  const waitMs = entry.pacer.spacingMs - (monoNow() - entry.lastRequestAt);
  if (waitMs > 0) await sleep(waitMs);
}

// Account actions need a reservation, not just a check-then-sleep: otherwise
// concurrent asks all wake on the same old lastRequestAt and dispatch together.
// Hold the account lane through the browser action so a long prompt fill cannot
// let the next prompt bunch immediately after its Send click.
async function reserveAccountAction(account) {
  const entry = getPacerEntry(normalizePacerKey(account));
  const previous = entry.actionTail;
  let unlock;
  entry.actionTail = new Promise((resolve) => { unlock = resolve; });
  await previous;
  while (entry.apiCheckReservation) await sleep(10);
  entry.actionInFlight = true;
  const priorRequestAt = entry.lastRequestAt;
  const waitMs = entry.pacer.spacingMs - (monoNow() - entry.lastRequestAt);
  if (waitMs > 0) await sleep(waitMs);
  const startedAtMono = monoNow();
  entry.lastRequestAt = startedAtMono;
  let consumed = false;
  let lastRequestAtMono = startedAtMono;
  return {
    entry,
    priorRequestAt,
    startedAtMono,
    get consumed() { return consumed; },
    recordRequestStart(requestAtMono) {
      consumed = true;
      lastRequestAtMono = Math.max(startedAtMono, requestAtMono);
      entry.lastRequestAt = Math.max(entry.lastRequestAt, lastRequestAtMono);
    },
    spacingMs: entry.pacer.spacingMs,
    release({ noRequest = false, completedAt = null } = {}) {
      if (noRequest && !consumed && entry.lastRequestAt === startedAtMono) entry.lastRequestAt = priorRequestAt;
      else if (completedAt != null && consumed) entry.lastRequestAt = Math.max(entry.lastRequestAt, completedAt, lastRequestAtMono);
      entry.actionInFlight = false;
      unlock();
    },
  };
}

// get_reply is mostly a local DOM read, so keep it responsive. Grant at most
// one API-check lease per account and only when the shared account gap permits
// it; content.js skips both the conversation read and new-chat discovery when
// the lease is denied. A result that did not actually call the API releases
// the lease without consuming request capacity.
function reserveApiCheck(account) {
  const entry = getPacerEntry(normalizePacerKey(account));
  const now = monoNow();
  if (entry.actionInFlight || entry.apiCheckReservation) return null;
  if (now - entry.lastRequestAt < entry.pacer.spacingMs) return null;
  const reservation = { startedAtMono: now, startedAt: new Date().toISOString(), spacingMs: entry.pacer.spacingMs };
  entry.apiCheckReservation = reservation;
  return { entry, reservation };
}

function finishApiCheck(reserved, { apiChecked = false, completedAt = null } = {}) {
  if (!reserved) return;
  const { entry, reservation } = reserved;
  if (entry.apiCheckReservation !== reservation) return;
  if (apiChecked) entry.lastRequestAt = completedAt == null ? reservation.startedAtMono : Math.max(reservation.startedAtMono, completedAt);
  entry.apiCheckReservation = null;
}

// A targeted tab is briefly absent whenever its page loads: navigating to a
// conversation or reloading tears the socket down, and the new page's socket
// connects a moment before it reports its account. A command aimed at that
// tab waits out that gap (bounded) instead of failing at once (2026-09-29:
// an ask's send_prompt landed 65 ms before the reloaded tab identified).
const TAB_RECONNECT_WAIT_MS = Number(process.env.TAB_RECONNECT_WAIT_MS) || 20000;
function targetTabReady(tab, account) {
  return [...extensionSockets].some((ws) => ws.readyState === ws.OPEN && ws.tabToken === tab && (!account || accountMatches(ws.account, account)));
}
async function waitForTargetTab(tab, account, waitMs) {
  const deadline = monoNow() + waitMs;
  while (!targetTabReady(tab, account) && monoNow() < deadline) await sleep(100);
}

async function dispatchToExtension(command, timeoutMs = COMMAND_TIMEOUT_MS, opts = {}) {
  if (opts.tab) await waitForTargetTab(opts.tab, opts.account, Math.min(TAB_RECONNECT_WAIT_MS, timeoutMs));
  const tracked = BACKEND_TOUCHING_ACTIONS.has(command.action);
  const alwaysReal = ALWAYS_REAL_ACTIONS.has(command.action);
  const pacerKey = normalizePacerKey(opts.account);
  const entry = getPacerEntry(pacerKey);
  const actionReservation = opts.pacingReservation || (alwaysReal ? await reserveAccountAction(opts.account) : null);
  const ownsActionReservation = Boolean(actionReservation && actionReservation !== opts.pacingReservation);
  const reservationSequenceAction = Boolean(opts.pacingReservation && PACING_SEQUENCE_ACTIONS.has(command.action));
  const apiCheckReservation = command.action === 'get_reply' ? reserveApiCheck(opts.account) : null;
  const dispatchCommand = command.action === 'get_reply'
    ? { ...command, api_check_allowed: Boolean(apiCheckReservation) }
    : command;
  if (tracked) {
    agentRequestsInFlight++;
    agentRequestsInFlightByAccount.set(pacerKey, (agentRequestsInFlightByAccount.get(pacerKey) || 0) + 1);
  }
  const startedMs = monoNow();
  const dispatchStartedWallMs = Date.now();
  const dispatchStartedAt = new Date(dispatchStartedWallMs).toISOString();
  let actionRelease = {};
  let requestStartedAt = dispatchStartedAt;
  let requestStartedMono = startedMs;
  try {
    const result = await dispatchToExtensionRaw(dispatchCommand, timeoutMs, opts);
    const apiChecked = command.action === 'get_reply' && result?.api_checked === true;
    const real = alwaysReal || reservationSequenceAction || apiChecked;
    if (apiCheckReservation) {
      const requestStart = requestStartFromResult(command.action, result, apiCheckReservation.reservation.startedAt, apiCheckReservation.reservation.startedAtMono, dispatchStartedWallMs);
      if (apiChecked) { requestStartedAt = requestStart.at; requestStartedMono = requestStart.mono; }
      finishApiCheck(apiCheckReservation, { apiChecked, completedAt: apiChecked ? requestStart.mono : null });
    }
    if (real) {
      if (actionReservation) {
        const requestStart = requestStartFromResult(command.action, result, dispatchStartedAt, startedMs, dispatchStartedWallMs);
        requestStartedAt = requestStart.at;
        requestStartedMono = requestStart.mono;
        actionReservation.recordRequestStart(requestStartedMono);
        actionRelease = { completedAt: requestStart.mono };
      }
      entry.lastRequestAt = requestStartedMono;
      const rateLimited = isRateLimitSignal(null, result);
      if (rateLimited) applyRateLimit(retryAfterMsOf(null, result), pacerKey); else entry.pacer.onSuccess();
      saveAgentPacerState();
      const completedAt = new Date().toISOString();
      appendRequestTiming({
        schema_version: 2, event_type: 'broker_action', action: command.action, ok: true,
        ...(opts.askId ? { ask_id: opts.askId } : {}),
        request_started_at: requestStartedAt, dispatch_started_at: dispatchStartedAt, completed_at: completedAt,
        duration_ms: Math.round(monoNow() - startedMs), rate_limited: rateLimited, spacing_ms: entry.pacer.spacingMs,
        spacing_ms_applied: actionReservation?.spacingMs ?? apiCheckReservation?.reservation.spacingMs ?? entry.pacer.spacingMs,
        next_spacing_ms: entry.pacer.spacingMs,
        ...(command.action === 'get_reply' ? { api_check_permitted: Boolean(apiCheckReservation) } : {}),
        account: pacerKey === DEFAULT_PACER_KEY ? null : pacerKey,
        tab: result?.tab?.slice(0, 8) ?? null, agent_tab: result?.agent ?? null, incognito: result?.incognito ?? null,
        api_checked: result?.api_checked ?? null, api_status: result?.api_status ?? null, ...(result?.api_limit_detail ? { api_limit_detail: result.api_limit_detail } : {}),
        ...(command.action === 'send_prompt' ? { send_confirmed: result?.send_confirmed ?? null, confirmed_by: result?.confirmed_by ?? null, visibility: result?.visibility ?? null, plain_text_mode: result?.plain_text_mode ?? null, typing_ms: result?.typing_ms ?? null, fill_mode: result?.fill_mode ?? null, fill_detail: result?.fill_detail ?? null } : {}),
        broker_actions_in_flight: agentRequestsInFlight, broker_actions_in_flight_account: agentRequestsInFlightByAccount.get(pacerKey) || 0,
        ...recordAndCountWindow(requestStartedMono, opts.account),
      });
    }
    return result;
  } catch (err) {
    const apiRequestUnknown = Boolean(apiCheckReservation && !err?.not_dispatched && err?.api_status == null);
    const apiChecked = Boolean(apiCheckReservation && (err?.api_status != null || apiRequestUnknown));
    const real = ((alwaysReal || reservationSequenceAction) && !err?.not_dispatched) || (command.action === 'get_reply' && (err?.api_status != null || apiRequestUnknown));
    if (apiCheckReservation) finishApiCheck(apiCheckReservation, { apiChecked, completedAt: apiCheckReservation.reservation.startedAtMono });
    if (actionReservation && err?.not_dispatched) actionRelease = { noRequest: true };
    if (real) {
      if (actionReservation) {
        actionReservation.recordRequestStart(startedMs);
      } else {
        entry.lastRequestAt = apiCheckReservation?.reservation.startedAtMono ?? startedMs;
      }
      const rateLimited = isRateLimitSignal(err, null);
      if (rateLimited) { applyRateLimit(retryAfterMsOf(err, null), pacerKey); saveAgentPacerState(); }
      const completedAt = new Date().toISOString();
      appendRequestTiming({
        schema_version: 2, event_type: 'broker_action', action: command.action, ok: false,
        ...(opts.askId ? { ask_id: opts.askId } : {}),
        request_started_at: actionReservation ? dispatchStartedAt : apiCheckReservation?.reservation.startedAt ?? dispatchStartedAt,
        dispatch_started_at: dispatchStartedAt, completed_at: completedAt, backend_request_unknown: apiRequestUnknown || undefined,
        duration_ms: Math.round(monoNow() - startedMs), rate_limited: rateLimited, error: err.message, spacing_ms: entry.pacer.spacingMs,
        spacing_ms_applied: actionReservation?.spacingMs ?? apiCheckReservation?.reservation.spacingMs ?? entry.pacer.spacingMs,
        next_spacing_ms: entry.pacer.spacingMs,
        ...(command.action === 'get_reply' ? { api_check_permitted: Boolean(apiCheckReservation) } : {}),
        account: pacerKey === DEFAULT_PACER_KEY ? null : pacerKey,
        tab: err?.tab?.slice(0, 8) ?? null, agent_tab: err?.agent ?? null, incognito: err?.incognito ?? null,
        api_checked: apiChecked || null, api_status: err?.api_status ?? null, ...(err?.api_limit_detail ? { api_limit_detail: err.api_limit_detail } : {}), ...(err?.stage ? { stage: err.stage } : {}), ...(err?.conversation_fetch ? { conversation_fetch: err.conversation_fetch, rendered_messages: err.rendered_messages } : {}), ...(err?.lifecycle ? { lifecycle: err.lifecycle } : {}), ...(err?.fill_detail ? { fill_detail: err.fill_detail } : {}),
        broker_actions_in_flight: agentRequestsInFlight, broker_actions_in_flight_account: agentRequestsInFlightByAccount.get(pacerKey) || 0,
        ...recordAndCountWindow(actionReservation?.startedAtMono ?? apiCheckReservation?.reservation.startedAtMono ?? startedMs, opts.account),
      });
    }
    throw err;
  } finally {
    if (apiCheckReservation && entry.apiCheckReservation === apiCheckReservation.reservation) finishApiCheck(apiCheckReservation);
    if (ownsActionReservation) actionReservation.release(actionRelease);
    if (tracked) {
      agentRequestsInFlight--;
      const remaining = Math.max(0, (agentRequestsInFlightByAccount.get(pacerKey) || 1) - 1);
      if (remaining) agentRequestsInFlightByAccount.set(pacerKey, remaining); else agentRequestsInFlightByAccount.delete(pacerKey);
    }
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
  const deadline = monoNow() + 15000;
  while (monoNow() < deadline) {
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
async function listRecentChats(limit = 28, { account = null, includeProjects = false, askId = null } = {}) {
  const r = await dispatchToExtension({ action: "list_recent_chats", limit }, COMMAND_TIMEOUT_MS, { single: true, account, askId });
  const chats = (r.chats || []).map((c) => ({ ...c, project_name: null }));
  if (!includeProjects) return chats;
  // The main list leaves out chats filed inside a Project; merge those in
  // (newest first) so a caller is not silently blind to them.
  const p = await dispatchToExtension({ action: "list_project_chats", per_project: Math.min(limit, 100) }, COMMAND_TIMEOUT_MS, { single: true, account, askId });
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

async function resolveThreadTitle(title, account = null, askId = null) {
  const matches = matchChatsByTitle(await listRecentChats(100, { account, includeProjects: true, askId }), title);
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
// Unpinned new asks reserve an account before probing browser tabs. This map
// counts only those not yet claimed; after a tab is claimed, claimedTabs owns
// the in-flight count. Keeping the sets disjoint lets the router add both
// queued automatic assignments and active pinned asks without undercounting.
const pendingAutoRoutes = new Map();

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
// Opening an agent tab. First choice: ask the extension in a tab already
// signed into the wanted account to open it (chrome.tabs.create). That tab's
// browser profile is by construction the one holding that account, and it
// works on any OS with no shell command. A shell command (AGENT_TAB_OPEN_CMD /
// SYNC_OPEN_CHATGPT_CMD) opens Chrome's default profile, so it cannot reach an
// account living in another profile (the 2026-09-29 two-account check failed
// that way, on top of a flaky WSL interop call); it is only the fallback when
// no tab of that account is connected.
async function openAgentTabViaExtension(account, askId = null) {
  const candidates = [...extensionSockets]
    .filter((ws) => ws.readyState === ws.OPEN && ws.tabToken && (!account || accountMatches(ws.account, account)))
    .sort((a, b) => Number(a.agentTab) - Number(b.agentTab)); // prefer a human tab: it is not busy with an ask
  const errors = [];
  for (const ws of candidates) {
    try {
      const r = await dispatchToExtension({ action: "open_agent_tab", url: AGENT_TAB_URL }, 10000, { tab: ws.tabToken, askId });
      if (r.ok !== false) return { via: ws.tabToken.slice(0, 8) };
      errors.push(`${ws.tabToken.slice(0, 8)}: ${r.reason}`);
    } catch (err) { errors.push(`${ws.tabToken.slice(0, 8)}: ${err.message}`); }
  }
  return { via: null, errors, candidates: candidates.length };
}
let openAgentTab = async ({ account = null, askId = null } = {}) => {
  const viaExtension = await openAgentTabViaExtension(account, askId);
  if (viaExtension.via) return;
  const why = viaExtension.candidates ? `the extension could not open one (${viaExtension.errors.join("; ")})` : `no tab${account ? ` signed into ${account}` : ''} is connected to open it from`;
  if (!AGENT_TAB_OPEN_CMD || !AGENT_TAB_OPEN_CMD.includes("ccm_agent=1")) {
    throw new Error(`No agent ChatGPT tab is open, and ${why}; no open command is set either (AGENT_TAB_OPEN_CMD or SYNC_OPEN_CHATGPT_CMD). Open ${AGENT_TAB_URL} in the browser profile signed into ${account || 'the account'}.`);
  }
  if (account) {
    throw new Error(`No agent ChatGPT tab signed into ${account}, and ${why}. The open command would use Chrome's default profile, which may be another account, so it is not used. Open ${AGENT_TAB_URL} in the browser profile signed into ${account}.`);
  }
  await runOpenCommand(AGENT_TAB_OPEN_CMD);
};
function setAgentTabOpener(fn) { openAgentTab = fn; }

// The account a tab reports on connecting. A freshly opened tab reports it a
// moment after it connects (content.js reportIdentity reads /api/auth/session),
// so wait briefly for it: the 2026-09-29 live check showed a new agent tab's
// first ask still logged account:null without this wait.
async function accountOfTab(tab, waitMs = 5000) {
  const deadline = monoNow() + waitMs;
  for (;;) {
    const ws = [...extensionSockets].find((w) => w.tabToken === tab && w.readyState === w.OPEN);
    const key = accountKey(ws?.account);
    // undefined: the tab has not reported yet; null: it reported no account.
    if (key || ws?.account !== undefined || monoNow() >= deadline) return key || null;
    await sleep(200);
  }
}

// Agent tabs whose page did not come back after a navigation (a frozen or
// discarded background tab: nb2 2026-09-29 12:03Z sat 60s on tab 82e7de0a,
// which never reconnected). They are skipped until they reconnect, i.e. until
// a socket for that tab connects after it was set aside.
const deadTabs = new Map(); // tabToken -> monoNow() when set aside
function setTabAside(tab) { deadTabs.set(tab, monoNow()); }
function tabSetAside(ws) {
  const at = deadTabs.get(ws.tabToken);
  if (at === undefined) return false;
  if (ws.connectedAtMono > at) { deadTabs.delete(ws.tabToken); return false; }
  return true;
}

async function findIdleAgentTab(seen, excludeTokens = new Set(), account = null) {
  const tokens = [...new Set([...extensionSockets]
    .filter((ws) => ws.readyState === ws.OPEN && ws.tabToken && ws.agentTab && !excludeTokens.has(ws.tabToken) && !tabSetAside(ws) && (!account || accountMatches(ws.account, account)))
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

function rankConnectedAgentAccounts(now = monoNow()) {
  const accounts = new Map();
  for (const ws of extensionSockets) {
    if (ws.readyState !== ws.OPEN || !ws.agentTab || !ws.account) continue;
    const account = accountKey(ws.account);
    if (!account) continue;
    const key = normalizePacerKey(account);
    if (!accounts.has(key)) accounts.set(key, key);
  }
  return [...accounts.values()].map((account) => {
    const entry = getPacerEntry(account);
    const spacingMs = entry.pacer.spacingMs;
    const pendingAutoAsks = pendingAutoRoutes.get(account) || 0;
    const inFlightAsks = [...extensionSockets].filter((candidate) => candidate.readyState === candidate.OPEN
      && candidate.agentTab && candidate.tabToken && claimedTabs.has(candidate.tabToken)
      && normalizePacerKey(accountKey(candidate.account)) === account).length;
    // pendingAutoAsks contains only unclaimed auto assignments; inFlightAsks
    // contains every claimed ask, pinned or automatic. These are disjoint
    // queues, so add them rather than taking the max.
    const estimatedAheadAsks = pendingAutoAsks + inFlightAsks;
    const nextEligibleAt = Math.max(now, entry.lastRequestAt + spacingMs);
    const projectedStartAt = nextEligibleAt + estimatedAheadAsks * spacingMs;
    return {
      account,
      spacingMs,
      pendingAutoAsks,
      inFlightAsks,
      estimatedAheadAsks,
      projectedStartAt,
      projectedStartInMs: Math.max(0, Math.round(projectedStartAt - now)),
    };
  }).sort((a, b) => a.projectedStartAt - b.projectedStartAt || a.account.localeCompare(b.account));
}

function reserveAutoRoute(account) {
  const key = normalizePacerKey(account);
  pendingAutoRoutes.set(key, (pendingAutoRoutes.get(key) || 0) + 1);
  let released = false;
  let pending = true;
  const leavePending = () => {
    if (!pending) return;
    pending = false;
    const count = pendingAutoRoutes.get(key) || 0;
    if (count <= 1) pendingAutoRoutes.delete(key);
    else pendingAutoRoutes.set(key, count - 1);
  };
  return {
    account: key,
    routeId: crypto.randomUUID(),
    markClaimed() { leavePending(); },
    release() {
      if (released) return;
      released = true;
      leavePending();
    },
  };
}

async function findRoutedIdleAgentTab(seen, excludeTokens = new Set()) {
  const ranked = rankConnectedAgentAccounts();
  // Preserve the existing single-account and unknown-identity behavior. The
  // router is only useful when at least two account identities are available.
  if (ranked.length < 2) return undefined;
  const candidates = ranked.map((candidate) => ({
    account: candidate.account,
    projected_start_in_ms: candidate.projectedStartInMs,
    spacing_ms: candidate.spacingMs,
    pending_auto_asks: candidate.pendingAutoAsks,
    in_flight_asks: candidate.inFlightAsks,
    estimated_ahead_asks: candidate.estimatedAheadAsks,
    idle_agent_tab: null,
  }));
  for (let i = 0; i < ranked.length; i++) {
    const candidate = ranked[i];
    // Reserve synchronously before the first async tab probe so a concurrent
    // ask sees this account's pending work in its own ranking.
    const reservation = reserveAutoRoute(candidate.account);
    const found = await findIdleAgentTab(seen, excludeTokens, candidate.account);
    candidates[i].idle_agent_tab = Boolean(found);
    if (!found) {
      reservation.release();
      continue;
    }
    // The ask now appears in claimedTabs/inFlightAsks. Remove it from the
    // pending count before another route can rank this account.
    reservation.markClaimed();
    try {
      appendRequestTiming({
        schema_version: 2,
        event_type: 'account_route',
        route_id: reservation.routeId,
        selection_rule: 'earliest_projected_start_with_idle_agent_tab',
        selected_account: candidate.account,
        candidates,
      });
    } catch (err) {
      claimedTabs.delete(found.tab);
      reservation.release();
      throw err;
    }
    return { ...found, routeReservation: reservation };
  }
  return null;
}

async function pickIdleTab({ openWaitMs = 90000, forceNew = false, account = null, autoRoute = false, askId = null } = {}) {
  const seen = [];
  const existing = new Set([...extensionSockets]
    .filter((ws) => ws.readyState === ws.OPEN && ws.tabToken && ws.agentTab)
    .map((ws) => ws.tabToken));
  if (!forceNew) {
    const routed = autoRoute && !account ? await findRoutedIdleAgentTab(seen) : null;
    if (routed) return routed;
    const found = routed === null && autoRoute && !account
      ? null
      : await findIdleAgentTab(seen, new Set(), account);
    if (found) return found;
  }
  try { await openAgentTab({ account, askId }); }
  catch (err) { throw new Error(`${err.message} (agent tabs checked first: ${JSON.stringify(seen)})`); }
  const deadline = monoNow() + openWaitMs;
  while (monoNow() < deadline) {
    await sleep(1000);
    const routed = autoRoute && !account ? await findRoutedIdleAgentTab(seen, forceNew ? existing : new Set()) : null;
    if (routed) return routed;
    if (autoRoute && !account) {
      if (routed === null) continue;
      const fallback = await findIdleAgentTab(seen, forceNew ? existing : new Set());
      if (fallback) return fallback;
      continue;
    }
    const next = await findIdleAgentTab([], forceNew ? existing : new Set(), account);
    if (next) return next;
  }
  const where = account ? ` signed into ${account} (the broker's open command uses the default browser profile; open ${AGENT_TAB_URL} yourself in the profile signed into that account)` : '';
  throw new Error(`No idle agent ChatGPT tab${where} (${JSON.stringify(seen)}); opened ${AGENT_TAB_URL} but no matching tab connected within ${Math.round(openWaitMs / 1000)}s (is the browser signed in and the extension enabled?).`);
}

// Every socket the broker has held for this tab since `reference`, with when
// it connected (ms after reference; negative = before) and its state.
// The reconnect is read when the wait ends: a get_tab can itself wait for the
// reconnecting page (waitForTargetTab), so a poll-time check misses it.
function finishNavDiag(diag, tab, reference) {
  diag.sockets = tabSocketsDiag(tab, reference);
  const after = diag.sockets.filter((x) => x.state === 1 && x.connected_ms > 0).map((x) => x.connected_ms);
  if (diag.reconnected_after_ms === null && after.length) diag.reconnected_after_ms = Math.max(...after);
  return diag;
}

function tabSocketsDiag(tab, reference) {
  return [...extensionSockets].filter((w) => w.tabToken === tab)
    .map((w) => ({ connected_ms: Math.round((w.connectedAtMono ?? NaN) - reference), state: w.readyState }));
}

async function waitForTab(tab, predicate, timeoutMs, what, { onPoll = null, since = null } = {}) {
  const startedAt = monoNow();
  // Reconnects are measured from `since` (when the navigation was sent): the
  // new page can connect before this wait starts.
  const reference = since ?? startedAt;
  const deadline = startedAt + timeoutMs;
  const diag = { polls: 0, last_thread_id: undefined, last_page_id: null, last_error: null, reconnected_after_ms: null };
  while (monoNow() < deadline) {
    await sleep(700);
    const newest = [...extensionSockets].filter((w) => w.tabToken === tab && w.readyState === w.OPEN).sort((a, b) => b.connectedAtMono - a.connectedAtMono)[0];
    if (newest && newest.connectedAtMono > reference && diag.reconnected_after_ms === null) diag.reconnected_after_ms = Math.round(newest.connectedAtMono - reference);
    diag.polls++;
    try {
      const info = await dispatchToExtension({ action: "get_tab" }, 3000, { tab });
      diag.last_thread_id = info.thread_id ?? null; diag.last_page_id = info.page_id ?? null; diag.last_error = null;
      if (predicate(info)) return { info, diag: finishNavDiag({ ...diag, elapsed_ms: Math.round(monoNow() - startedAt) }, tab, reference) };
    } catch (err) { diag.last_error = err.message; /* reconnecting after navigation */ }
    if (onPoll) await onPoll(diag, monoNow() - startedAt);
  }
  diag.elapsed_ms = Math.round(monoNow() - startedAt);
  finishNavDiag(diag, tab, reference);
  const where = diag.last_thread_id === undefined ? 'never answered' : `still showed ${diag.last_thread_id ? `conversation ${diag.last_thread_id}` : 'no conversation'}`;
  const reload = diag.reconnected_after_ms === null ? 'no page reload was seen' : `it reconnected after ${diag.reconnected_after_ms}ms`;
  const seen = `the tab ${where} (${reload}; ${diag.polls} checks${diag.last_error ? `; last error: ${diag.last_error}` : ''})`;
  throw Object.assign(new Error(`ChatGPT tab never ${what} within ${Math.round(timeoutMs / 1000)}s: ${seen}. Nothing was sent.`), { nothing_sent: true, navigation_diag: diag });
}

// A full page load in a background tab can take well over 20s (ChatGPT's
// bundle, throttled timers): 2 of ~20 new-chat asks on 2026-09-29 failed the
// old 20s bound, with nothing sent. Wait up to NAV_WAIT_MS, re-issue the
// navigation once if the tab is back but on the wrong page, and log every
// navigation (request-timing.jsonl action "navigate") with its timings on the
// steady clock.
const NAV_WAIT_MS = Number(process.env.NAV_WAIT_MS || 60000);
// One rule for every path that ends with "this tab is gone": it never answered
// or never came back from a page load/reload, AND nothing was typed or even
// dispatched to it. Such an ask moves to another tab (askChatgpt); anything
// that may have reached ChatGPT never does.
function tabGone(err) {
  return err?.tab_dead === true && (err.nothing_sent === true || err.not_dispatched === true) && err.sent_unknown !== true;
}
const NAV_DEAD_MS = Number(process.env.NAV_DEAD_MS || 20000);
async function navigateAndWait(tab, { threadId = null, account = null, pacingReservation = null, askId = null }) {
  const command = threadId ? { action: "navigate_to_thread", thread_id: threadId } : { action: "navigate_home" };
  const predicate = threadId ? (i) => i.thread_id === threadId : (i) => !i.thread_id;
  const what = threadId ? `opened conversation ${threadId}` : "opened a new chat";
  const startedMs = monoNow();
  let reissued = false;
  try {
    await dispatchToExtension(command, COMMAND_TIMEOUT_MS, { tab, account, pacingReservation, askId });
    const { diag } = await waitForTab(tab, predicate, NAV_WAIT_MS, what, {
      since: startedMs,
      onPoll: async (d, elapsed) => {
        // The page has neither answered nor reconnected for NAV_DEAD_MS: the
        // tab is frozen or discarded and waiting longer does not help (nb2,
        // 2026-09-29: 60s on a tab that never came back). Give it up; the ask
        // moves to another tab. Nothing was sent.
        const reconnectedSince = [...extensionSockets].some((w) => w.tabToken === tab && w.readyState === w.OPEN && w.connectedAtMono > startedMs);
        if (elapsed > NAV_DEAD_MS && d.last_thread_id === undefined && !reconnectedSince) {
          throw Object.assign(new Error(`ChatGPT agent tab ${tab.slice(0, 8)} did not come back within ${Math.round(NAV_DEAD_MS / 1000)}s after the page load (no answer, no reconnect; last error: ${d.last_error}). Nothing was sent.`), { nothing_sent: true, tab_dead: true, navigation_diag: { ...d, elapsed_ms: Math.round(elapsed) } });
        }
        // Back on a page, but not the target: the navigation was lost.
        if (!reissued && elapsed > NAV_WAIT_MS / 2 && d.last_error === null && d.last_thread_id !== undefined) {
          reissued = true;
          await dispatchToExtension(command, COMMAND_TIMEOUT_MS, { tab, account, pacingReservation, askId }).catch(() => {});
        }
      },
    });
    appendRequestTiming({ action: 'navigate', target: threadId || 'new_chat', ok: true, tab: tab.slice(0, 8), account: account || null, duration_ms: Math.round(monoNow() - startedMs), reissued, ...diag });
  } catch (err) {
    appendRequestTiming({ action: 'navigate', target: threadId || 'new_chat', ok: false, tab: tab.slice(0, 8), account: account || null, duration_ms: Math.round(monoNow() - startedMs), reissued, error: err.message.slice(0, 300), ...(err.navigation_diag || {}) });
    throw err;
  }
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

// When an unconfirmed send still shows nothing, ask the tab to check the
// server and, if the prompt has not arrived, click Send again. Spaced out
// because a hidden tab's own timers can be throttled to about once a minute.
const RETRY_CLICK_AFTER_MS = (process.env.RETRY_CLICK_AFTER_MS || '30000,75000,135000').split(',').map(Number).filter((n) => n > 0);

// Conversations already handed to an ask (in flight or answered). The
// extension's server-side search for an unconfirmed new chat skips these, so
// two asks with identical text never claim the same conversation. Bounded.
const attributedThreads = new Set();
// The message count each conversation had when an ask last read it, so a
// continuation needs no pre-send read of a possibly huge conversation.
const threadMessageCounts = new Map();
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
    const askId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startedMs = monoNow();
    let last = null;
    let resolvedThreadId = thread_id;
    let conversationMode = thread_id || thread_title ? 'continuing' : 'new';
    let claimedTab = null;
    const requestedAccount = account;
    let usedAccount = account;
    let autoRouteReservation = null;
    let routeId = null;
    const autoRoute = !requestedAccount && !thread_id && !thread_title && !fresh_tab;
    let sendSeen = null;
    // Only send_prompt types the prompt. Until one has reached a tab, a
    // failure (tab pick, navigation, a tab that never reconnected) is sent=no.
    let sendDispatched = false;
    let sentThreadId = null;
    const retryClicks = [];
    try {
      if (thread_id) resolvedThreadId = threadIdFromInput(thread_id);
      if (thread_title) resolvedThreadId = await resolveThreadTitle(thread_title, account, askId);
      const onTargetPage = (i) => (resolvedThreadId ? i.thread_id === resolvedThreadId : !i.thread_id);
      // Claim a tab and get it onto the target page. A tab that does not come
      // back from the page load is set aside (skipped until it reconnects) and
      // the ask moves to another idle agent tab, or opens a fresh one: at most
      // three tabs, one ask per tab (claimedTabs), nothing sent meanwhile.
      let tab = null;
      // Everything from claiming a tab to the prompt being handed to it. If the
      // tab turns out to be gone (it never answers, or never comes back from a
      // page load or reload) before anything was typed, the ask sets it aside
      // and starts over on another tab: see tabGone below.
      const sendOnTab = async (pacingReservation = null) => {
      const sendPrompt = () => dispatchToExtension(
        { action: "send_prompt", text: body, exclude_threads: [...attributedThreads], messages_before_hint: resolvedThreadId ? (threadMessageCounts.get(resolvedThreadId) ?? null) : null },
        sendTimeoutMs ?? promptDispatchTimeoutMs(timeout_seconds),
        { tab, account, pacingReservation, askId },
      ).then((r) => { sendDispatched = true; return r; }, (e) => { if (!e.not_dispatched) sendDispatched = true; throw e; });
      let sent;
      try {
        try {
          sent = await sendPrompt(pacingReservation);
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
          // A continuation page that rendered no messages is waiting on its own
          // load of the conversation; when ChatGPT refused that load (HTTP 429)
          // the page stays empty, and reloading straight away hits the same
          // limit (rph5, 16:44-16:48Z: the reload 28s later failed the same
          // way while the account's reads were still being refused). Treat
          // it as the account's rate limit: widen that account's pacer and
          // wait it out before reloading, as far as the caller's time allows.
          const loadRefused = err.stage === 'no_composer' && resolvedThreadId
            && (err.conversation_fetch?.status === 429 || (err.rendered_messages === 0 && !err.conversation_fetch?.status));
          if (loadRefused) {
            applyRateLimit(null, normalizePacerKey(account));
            const spacing = getPacerEntry(normalizePacerKey(account)).pacer.spacingMs;
            const remaining = timeout_seconds * 1000 - (monoNow() - startedMs);
            if (spacing > remaining - 60000) {
              throw Object.assign(new Error(`${err.message} ChatGPT did not load this conversation for the page${err.conversation_fetch?.status ? ` (HTTP ${err.conversation_fetch.status})` : ''}, which happens while it rate-limits the account; waiting ${Math.round(spacing / 1000)}s before a reload would exceed this ask's timeout. ${nothingSent}`), { nothing_sent: true, rate_limited_load: true });
            }
            appendRequestTiming({ action: 'wait_for_conversation_load', tab: tab.slice(0, 8), account: account || null, wait_ms: Math.round(spacing), conversation_fetch: err.conversation_fetch || null, rendered_messages: err.rendered_messages ?? null });
          }
          await waitForPacerGap(account);
          if (err.stage === 'no_composer') {
            appendRequestTiming({ action: 'reload_for_composer', ok: true, tab: tab.slice(0, 8), account: account || null, page_id: err.page_id });
            // Not awaited: the page may unload before its reply crosses the
            // socket. The new page instance reporting in is the real signal.
            dispatchToExtension({ action: "reload_tab" }, 5000, { tab, account, pacingReservation, askId }).catch(() => {});
            await waitForTab(tab, (i) => Boolean(i.page_id) && i.page_id !== err.page_id && onTargetPage(i), 20000, "reloaded the conversation page")
              .catch((reloadErr) => { throw Object.assign(new Error(`${err.message} Reloading the tab to recover failed: ${reloadErr.message} ${nothingSent}`), { nothing_sent: true, tab_dead: reloadErr.navigation_diag?.last_thread_id === undefined }); });
          }
          try {
            sent = await sendPrompt(pacingReservation);
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
        const stalled = () => Object.assign(new Error(`The ChatGPT agent tab stopped responding while typing or sending this ${body.length}-character prompt (no answer from the tab in ${Math.round((sendTimeoutMs ?? promptDispatchTimeoutMs(timeout_seconds)) / 1000)}s; it may have frozen or reloaded). Whether the prompt reached ChatGPT is unknown: check list_chatgpt_chats${resolvedThreadId ? ` or read_chatgpt_chat("${resolvedThreadId}")` : ''} before resending.`), { sent_unknown: true, tab_stalled: true });
        if (!/Timed out waiting for the browser extension/i.test(err.message)) throw err;
        // The tab took the prompt but never answered. A new chat's first send
        // can navigate the page and drop the answer (recovered below);
        // otherwise the tab froze or reloaded while typing or sending
        // (2026-09-29: large prompts froze it for 5 minutes). Say so, instead
        // of a bare timeout.
        if (conversationMode !== 'new') throw stalled();
        const currentTab = await dispatchToExtension({ action: "get_tab" }, 5000, { tab, askId }).catch(() => ({}));
        if (!currentTab.thread_id) throw stalled();
        sent = { thread_id: currentTab.thread_id, dom_before: 0, messages_before: 0, recovered_after_navigation: true };
      }
        return sent;
      };
      let sent;
      const tabsGivenUp = [];
      let lastGoneErr = null;
      for (let attempt = 1; ; attempt++) {
        let picked;
        try {
          picked = await pickIdleTab({ openWaitMs, forceNew: fresh_tab, account: requestedAccount, autoRoute, askId });
        } catch (pickErr) {
          // No other tab to move to: report why the previous one was given up.
          if (!lastGoneErr) throw pickErr;
          throw Object.assign(lastGoneErr, { message: `${lastGoneErr.message} No other agent tab became available (${pickErr.message})` });
        }
        if (autoRouteReservation) autoRouteReservation.release();
        autoRouteReservation = picked.routeReservation || null;
        routeId = autoRouteReservation?.routeId || null;
        tab = picked.tab;
        claimedTab = tab;
        const current = picked.thread_id;
        // Pace and log under the account the tab is actually signed into, even
        // when the caller named none (issue #28: every audit send was logged
        // account:null and shared the default pacer bucket).
        account = requestedAccount || picked.account || await accountOfTab(tab);
        usedAccount = account;
        // Loading a conversation page makes ChatGPT fetch that conversation --
        // a real request on the account -- so the pacer's gap is waited out
        // BEFORE navigating, not between the page load and the send. Both
        // 2026-09-27 "no composer" failures navigated 10-13s after an HTTP 429
        // and then sat ~2 min in the pacer on a page that never showed a
        // composer. The send below then needs no second wait.
        const pacingReservation = await reserveAccountAction(account);
        try {
          if (resolvedThreadId && current !== resolvedThreadId) await navigateAndWait(tab, { threadId: resolvedThreadId, account, pacingReservation, askId });
          else if (!resolvedThreadId && current) await navigateAndWait(tab, { account, pacingReservation, askId });
          sent = await sendOnTab(pacingReservation);
          break;
        } catch (err) {
          if (!tabGone(err) || attempt >= 3) throw err;
          lastGoneErr = err;
          setTabAside(tab);
          tabsGivenUp.push(tab.slice(0, 8));
          appendRequestTiming({ action: 'tab_set_aside', tab: tab.slice(0, 8), reason: err.message.slice(0, 200) });
          claimedTabs.delete(tab);
          claimedTab = null;
          if (autoRouteReservation) autoRouteReservation.release();
          autoRouteReservation = null;
          routeId = null;
        } finally {
          pacingReservation.release({ noRequest: !pacingReservation.consumed });
        }
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
      const deadline = monoNow() + timeout_seconds * 1000;
      const sentAtMs = monoNow();
      const retryClickAfterMs = [...RETRY_CLICK_AFTER_MS];
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
      while (monoNow() < deadline || monoNow() < confirmUntil) {
        await sleep(pollMs);
        try { last = await dispatchToExtension({ action: "get_reply", dom_before: sent.dom_before, messages_before: sent.messages_before, expected: body, thread_hint: sentThreadId, exclude_threads: [...attributedThreads] }, 30000, { tab, account, askId }); }
        catch (err) { last = { done: false, error: err.message }; continue; }
        if (!sendSeen && !last.discovered_thread_id && retryClickAfterMs.length && monoNow() - sentAtMs >= retryClickAfterMs[0]) {
          retryClickAfterMs.shift();
          try {
            const retry = await dispatchToExtension({ action: "retry_send_click", expected: body, thread_before: conversationMode === 'new' ? null : resolvedThreadId,
              messages_before: sent.messages_before, exclude_threads: [...attributedThreads] }, 60000, { tab, account, askId });
            retryClicks.push({ after_ms: monoNow() - sentAtMs, clicked: Boolean(retry.clicked), confirmed_by: retry.confirmed_by || null, reason: retry.reason || null });
            if (retry.confirmed_by) {
              sendSeen = true;
              if (retry.thread_id && !sentThreadId) { sentThreadId = retry.thread_id; noteAttributedThread(sentThreadId); }
            }
          } catch (err) { retryClicks.push({ after_ms: monoNow() - sentAtMs, error: err.message }); }
        }
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
          confirmUntil = monoNow() + confirmGraceMs;
          continue;
        }
        const threadId = last.thread_id || sentThreadId || resolvedThreadId || null;
        noteAttributedThread(threadId);
        if (threadId && Number.isInteger(last.message_count) && last.source === 'api') threadMessageCounts.set(threadId, last.message_count);
        appendBridgeObservation({ started_at: startedAt, ended_at: new Date().toISOString(), duration_ms: Math.round(monoNow() - startedMs), outcome: 'success', account: usedAccount || null, ask_id: askId, route_id: routeId || undefined, prompt_escaped: last.prompt_escaped ? true : undefined, retry_clicks: retryClicks.length ? retryClicks : undefined, failure_kind: null, visible_error: null, conversation_mode: conversationMode, thread_id: threadId, prompt_chars: body.length, history_message_count: Number.isInteger(last.message_count) ? last.message_count : null, history_chars: null, thinking_level: 'unknown' });
        // The caller must know when the model did not get the prompt verbatim.
        // Evidence, not the switch's own report: the stored turn is compared with
        // the prompt (replyFromTree's prompt_escaped).
        const verbatim = !last.prompt_escaped;
        return { thread_id: threadId, url: threadId ? `https://chatgpt.com/c/${threadId}` : null, reply: last.reply, images: last.images, account: usedAccount || null,
          prompt_verbatim: verbatim, ...(sent.plain_text_mode !== true && sent.plain_text_mode != null ? { plain_text_mode_error: String(sent.plain_text_mode) } : {}),
          ...(last.prompt_escaped ? { prompt_escaped: true } : {}) };
      }
      throw new Error(askTimeoutMessage({ timeout_seconds, sendSeen, threadId: last?.thread_id || sent.thread_id || resolvedThreadId || null, last, sent }));
    } catch (err) {
      // After a click nothing proves "not sent", so an unconfirmed click is
      // unknown, never false (the 2026-09-29 live check returned sent:false
      // for an unconfirmed large prompt).
      err.sent = err.sent_unknown ? null : (err.nothing_sent || !sendDispatched) ? false : sendSeen ? true : null;
      err.thread_id = last?.thread_id || sentThreadId || resolvedThreadId || null;
      err.account = usedAccount || null;
      appendBridgeObservation({ started_at: startedAt, ended_at: new Date().toISOString(), duration_ms: Math.round(monoNow() - startedMs), outcome: 'failed', account: usedAccount || null, ask_id: askId, route_id: routeId || undefined, sent: err.sent, retry_clicks: retryClicks.length ? retryClicks : undefined, failure_kind: bridgeFailureKind(err, last), visible_error: last?.visible_error || null, error_message: String(err?.message || '').replace(/ \(last seen: .*$/s, '').slice(0, 300), conversation_mode: conversationMode, thread_id: last?.thread_id || resolvedThreadId || null, prompt_chars: body.length, history_message_count: Number.isInteger(last?.message_count) ? last.message_count : null, history_chars: null, thinking_level: 'unknown' });
      throw err;
    } finally {
      if (claimedTab) claimedTabs.delete(claimedTab);
      if (autoRouteReservation) autoRouteReservation.release();
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
  try { const result = await dispatchToExtension({ action: 'archive_all_chats', known: incremental ? sync.knownThreads() : null }, COMMAND_TIMEOUT_MS, { single: true, account: SYNC_ACCOUNT }); res.json(result); }
  catch (err) { res.status(503).json({ error: err.message }); }
});
// Read-only inventory of the account's chat ids (no archive writes, no prompts).
app.get('/api/inventory-chats', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const r = await dispatchToExtension({ action: 'inventory_chats' }, 10 * 60 * 1000, { single: true, account: req.query.account || SYNC_ACCOUNT || null });
    // null = ChatGPT reported no total (older extension or changed schema): unknown, not "complete".
    const reported = Number.isFinite(r.ordinary_reported_total) ? r.ordinary_reported_total : null;
    res.json({
      ordinary_count: r.ordinary_list.length,
      project_chat_count: r.projects.reduce((n, p) => n + p.chats.length, 0),
      ...r,
      ordinary_reported_total: reported,
      ordinary_matches_reported_total: reported === null ? null : reported === r.ordinary_list.length,
    });
  } catch (err) { res.status(503).json({ error: err.message }); }
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
  const mcp = new McpServer({ name: "chatgpt-conversation-manager", version: "0.9.21" });

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
      // ChatGPT stored the prompt markdown-escaped (code fences as \`\`\`,
      // indentation as &#x20;), so the model read that form, not the raw text.
      // Put a failed verbatim send in front of the caller, not only in the log.
      const escapedNote = r.prompt_verbatim === false
        ? ` — WARNING: this prompt did NOT reach ChatGPT verbatim${r.plain_text_mode_error ? ` (the bridge could not switch ChatGPT's composer to plain-text mode: ${r.plain_text_mode_error})` : ''}; ChatGPT stored it changed (as escaped Markdown, or wrapped whole in a code fence), so the model read it in that form. The reply is still the answer to this prompt. See README "If prompts stop arriving verbatim".`
        : r.plain_text_mode_error ? ` — note: the bridge could not switch ChatGPT's composer to plain-text mode (${r.plain_text_mode_error}); this prompt still arrived verbatim, but one containing a link would not. See README "If prompts stop arriving verbatim".` : '';
      const content = [{ type: 'text', text: `${r.reply}\n\n[conversation ${r.thread_id} — ${r.url}${r.account ? ` — account ${r.account}` : ''}${escapedNote}]` }];
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
  syncAccount: SYNC_ACCOUNT,
  dispatch: (command, account) => dispatchToExtension(command, COMMAND_TIMEOUT_MS, { single: true, account }),
  connectionCount: (account) => [...extensionSockets].filter((ws) => ws.readyState === ws.OPEN && (!account || accountMatches(ws.account, account))).length,
  waitForBulkComplete,
  statusPath: path.join(ARCHIVE_DIR, 'metadata', 'sync-status.json'),
  openCommand: process.env.SYNC_OPEN_CHATGPT_CMD || null,
});
const SYNC_INTERVAL_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES || 0);

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // A missing or placeholder token used to start silently with "change-me",
  // which the extension also pre-fills: an open door to the account.
  if (!process.env.RENAMER_TOKEN || ['change-me', 'replace-with-a-long-random-token'].includes(AUTH_TOKEN) || AUTH_TOKEN.length < 16) {
    console.error('RENAMER_TOKEN is missing, a placeholder, or shorter than 16 characters. Set a long random value in .env (see README "Install"), e.g. `openssl rand -hex 24`.');
    process.exit(1);
  }
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`port ${PORT} on ${HOST} is already in use. Another broker is probably running already (check: curl http://localhost:${PORT}/health), or something else uses the port (set PORT in .env). Only one thing may start the broker: see README "Keeping the broker running".`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, HOST, () => {
    logInfo(`Conversation manager listening on http://${HOST}:${PORT}`);
    logInfo(`Archive: ${ARCHIVE_DIR}`);
    logInfo(`MCP:     http://localhost:${PORT}/mcp`);
    if (SYNC_INTERVAL_MINUTES > 0) {
      sync.start(SYNC_INTERVAL_MINUTES * 60 * 1000);
      logInfo(`Sync:    incremental backup every ${SYNC_INTERVAL_MINUTES} min (status: GET /api/sync-status)`);
    }
  });
}

export { readChatgptChat, listRecentChats, listConnections, threadIdFromInput, formatChatTranscript, app, server, archive, sync, askChatgpt, waitForBulkComplete, setAgentTabOpener, matchChatsByTitle, runOpenCommand, promptDispatchTimeoutMs, BRIDGE_OBSERVATIONS_PATH, REQUEST_TIMING_PATH, DOM_ACTIVITY_PATH, agentPacer, getPacerEntry, dispatchToExtension, broadcastReloadTab };
