import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';

const TOKEN = 'test-token-123';
let baseUrl;
let wsUrl;
let server;
let askChatgpt;
let setAgentTabOpener;
let matchChatsByTitle;
let runOpenCommand;
let waitForBulkComplete;
let promptDispatchTimeoutMs;
let bridgeObservationsPath;
let archive;
let agentPacer;
let requestTimingPath;
let domActivityPath;

before(async () => {
  process.env.PORT = '0';
  process.env.RENAMER_TOKEN = TOKEN;
  process.env.BULK_ORPHAN_GRACE_MS = '200';
  process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-server-test-'));
  const mod = await import('../server/index.js');
  server = mod.server;
  askChatgpt = mod.askChatgpt;
  setAgentTabOpener = mod.setAgentTabOpener;
  matchChatsByTitle = mod.matchChatsByTitle;
  runOpenCommand = mod.runOpenCommand;
  waitForBulkComplete = mod.waitForBulkComplete;
  promptDispatchTimeoutMs = mod.promptDispatchTimeoutMs;
  bridgeObservationsPath = mod.BRIDGE_OBSERVATIONS_PATH;
  archive = mod.archive;
  agentPacer = mod.agentPacer;
  requestTimingPath = mod.REQUEST_TIMING_PATH;
  domActivityPath = mod.DOM_ACTIVITY_PATH;
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  wsUrl = `ws://127.0.0.1:${server.address().port}/extension?token=${TOKEN}`;
});

// The agent request pacer is shared, module-level state that reacts to a
// "too_many_requests" visible_error/message on ANY dispatch, not only in the
// tests dedicated to it -- an existing test that deliberately manufactures
// that signal to test unrelated failure-classification logic triggered it as
// a side effect, leaving spacingMs elevated (its own hardcoded 1000ms rate-
// limit floor) for every test that ran afterward, each paying real wall-clock
// wait for a pacer it never asked about (observed: one later test alone grew
// from ~0.8s to ~8.3s). Reset it before every test so pacer state never
// leaks across tests that don't explicitly exercise it.
beforeEach(() => {
  agentPacer.minMs = 0;
  agentPacer.spacingMs = 0;
});

after(() => {
  server.close();
});

function authed(path, options = {}) {
  return fetch(`${baseUrl}${path}`, { ...options, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
}

test('GET /health reports ok without requiring auth', async () => {
  const res = await fetch(`${baseUrl}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.extension_connections, 0);
});

test('prompt dispatch timeout outlives the extension new-thread recovery ceiling', () => {
  assert.equal(promptDispatchTimeoutMs(20), 120000);
  assert.equal(promptDispatchTimeoutMs(180), 210000);
  assert.equal(promptDispatchTimeoutMs(900), 300000);
});

test('protected endpoints reject requests without a valid bearer token', async () => {
  const res = await fetch(`${baseUrl}/api/search?q=test`);
  assert.equal(res.status, 401);
  const res2 = await fetch(`${baseUrl}/api/search?q=test`, { headers: { Authorization: 'Bearer wrong-token' } });
  assert.equal(res2.status, 401);
});

test('GET /api/search with no matching archive returns an empty result set, not an error', async () => {
  const res = await authed('/api/search?q=nonexistent-term');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.results, []);
});

test('GET /api/thread/:id returns 404 for an unknown thread with a clear error message', async () => {
  const res = await authed('/api/thread/does-not-exist');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /Unknown archived thread/);
});

test('GET /api/thread/:id?full=1 returns the authoritative archived messages', async () => {
  archive.archiveSnapshot({
    thread_id: 'full-thread',
    title: 'Full thread',
    messages: [
      { role: 'user', text: 'question' },
      { role: 'assistant', text: 'complete answer' },
    ],
  });
  const res = await authed('/api/thread/full-thread?full=1');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.messages.at(-1).text, 'complete answer');
});

test('POST /api/capture surfaces a clear 503 when no extension is connected (broker-unavailable observability)', async () => {
  const res = await authed('/api/capture', { method: 'POST' });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /No browser extension is connected/);
});

test('POST /api/project surfaces the same broker-unavailable error rather than a generic 500', async () => {
  const res = await authed('/api/project', { method: 'POST', body: JSON.stringify({ project: 'Alpha' }) });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /No browser extension is connected/);
});

function connectFakeExtension() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Regression: dispatchToExtension used to resolve/reject on the FIRST reply
// from ANY connected tab. With multiple tabs open (normal usage, not an edge
// case), a stale/incapable tab replying with an error faster than a capable
// tab doing real work would fail the whole command even though another tab
// could have succeeded. Fixed to only fail once every connected tab has failed.
test('dispatchToExtension succeeds if ANY connected tab succeeds, even when a faster tab fails first', async () => {
  const slowButCapable = await connectFakeExtension();
  const fastButBroken = await connectFakeExtension();
  await new Promise((r) => setTimeout(r, 50)); // let both register server-side

  const handler = (ws, { failFast }) => (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'command') return;
    if (failFast) {
      ws.send(JSON.stringify({ type: 'command_result', id: msg.id, ok: false, error: 'stale tab cannot do this' }));
    } else {
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'command_result', id: msg.id, ok: true, thread_id: 'won-the-race' }));
      }, 100); // slower, but it's the one that actually succeeds
    }
  };
  slowButCapable.on('message', handler(slowButCapable, { failFast: false }));
  fastButBroken.on('message', handler(fastButBroken, { failFast: true }));

  try {
    const res = await authed('/api/capture', { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.thread_id, 'won-the-race');
  } finally {
    slowButCapable.close();
    fastButBroken.close();
  }
});

test('dispatchToExtension fails only once every connected tab has failed', async () => {
  const a = await connectFakeExtension();
  const b = await connectFakeExtension();
  await new Promise((r) => setTimeout(r, 50));

  const failHandler = (ws, message) => (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'command') return;
    ws.send(JSON.stringify({ type: 'command_result', id: msg.id, ok: false, error: message }));
  };
  a.on('message', failHandler(a, 'tab A cannot do this'));
  b.on('message', failHandler(b, 'tab B cannot do this'));

  try {
    const res = await authed('/api/capture', { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.match(body.error, /cannot do this/);
  } finally {
    a.close();
    b.close();
  }
});

function fakeTab(tab, { busy = false, thread = null, agent = false, onCommand }) {
  const state = { busy, thread, received: [], ws: null };
  const open = () => new Promise((resolve) => {
    const ws = new WebSocket(`${wsUrl}&tab=${tab}${agent ? '&agent=1' : ''}`);
    state.ws = ws;
    ws.on('open', resolve);
    ws.on('message', async (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type !== 'command') return;
      state.received.push(msg.action);
      // Mirrors extension/content.js's requestContext: every real reply
      // carries tab/agent/incognito, so the fake tab does too by default
      // (a test can still override any of them via extra).
      const reply = (extra) => ws.send(JSON.stringify({ type: 'command_result', id: msg.id, tab, agent, incognito: false, ...extra }));
      if (msg.action === 'get_tab') return reply({ ok: true, tab, agent, busy: state.busy, thread_id: state.thread });
      if (state.busy && ['navigate_home', 'navigate_to_thread', 'send_prompt'].includes(msg.action)) {
        return reply({ ok: false, error: 'busy: a bulk archive is running in this tab' });
      }
      await onCommand(msg, state, reply, open);
    });
  });
  state.open = open;
  return state;
}

test('ask_chatgpt uses the idle agent tab, never Brian\'s tab, starts a new chat, and waits for the finished reply', async () => {
  const human = fakeTab('human-tab-0000', { thread: 'brians-chat', onCommand: async (msg, state, reply) => reply({ ok: false, error: 'should not be used' }) });
  const busy = fakeTab('busy-tab-0001', { busy: true, agent: true, thread: 'archive-thread', onCommand: async () => {} });
  let polls = 0;
  const idle = fakeTab('idle-tab-0002', {
    agent: true,
    thread: 'old-thread',
    onCommand: async (msg, state, reply, reopen) => {
      if (msg.action === 'navigate_home') {
        reply({ ok: true, navigated: true });
        state.ws.close();
        state.thread = null;
        setTimeout(() => reopen(), 200);          // the page reloads and reconnects with the same tab token
        return;
      }
      if (msg.action === 'send_prompt') {
        assert.equal(msg.text, 'hello from an agent');
        state.thread = 'new-thread-123';
        return reply({ ok: true, thread_id: 'new-thread-123', dom_before: 0, messages_before: 0 });
      }
      if (msg.action === 'get_reply') {
        polls++;
        assert.equal(msg.dom_before, 0);
        assert.equal(msg.messages_before, 0);
        if (polls === 1) return reply({ ok: true, done: false, generating: true });
        if (polls === 2) return reply({ ok: true, done: true, reply: 'hello ba', thread_id: 'new-thread-123' });   // paused mid-stream
        return reply({ ok: true, done: true, reply: 'hello back', thread_id: 'new-thread-123' });
      }
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await human.open();
  await busy.open();
  await idle.open();
  try {
    const r = await askChatgpt({ text: 'hello from an agent', timeout_seconds: 20, pollMs: 50 });
    assert.equal(r.reply, 'hello back');
    assert.equal(r.thread_id, 'new-thread-123');
    assert.ok(polls >= 4, 'it returned before the same finished text was seen twice');
    assert.deepEqual(busy.received.filter((a) => a !== 'get_tab'), [], 'the busy tab received a navigation or send');
    assert.ok(idle.received.includes('navigate_home') && idle.received.includes('send_prompt'));
    assert.deepEqual(human.received, [], 'Brian\'s own tab received a command');
  } finally {
    human.ws.close();
    busy.ws.close();
    idle.ws.close();
  }
});

// Regression: askChatgpt() used to serialize every call through one global
// queue, so two concurrent asks always ran one after another even with two
// idle agent tabs open. Each concurrent call must claim its own tab and run
// in parallel, with neither prompt landing on the other's tab.
test('ask_chatgpt runs two concurrent asks in parallel, one per idle agent tab', async () => {
  function slowIdleTab(tab, expectedText, replyText, threadId) {
    return fakeTab(tab, {
      agent: true,
      onCommand: async (msg, state, reply) => {
        if (msg.action === 'navigate_home') return reply({ ok: true, navigated: true });
        if (msg.action === 'send_prompt') {
          assert.equal(msg.text, expectedText, `${tab} received the wrong prompt`);
          state.thread = threadId;
          return reply({ ok: true, thread_id: threadId, dom_before: 0, messages_before: 0 });
        }
        if (msg.action === 'get_reply') {
          // Hold the reply until both concurrent calls have had a chance to
          // start, so a bug that serializes them would show up as one tab
          // finishing fully before the other even receives its send_prompt.
          await new Promise((r) => setTimeout(r, 150));
          return reply({ ok: true, done: true, reply: replyText, thread_id: threadId });
        }
        reply({ ok: false, error: `unexpected ${msg.action}` });
      },
    });
  }
  const tabA = slowIdleTab('concurrent-tab-a', 'question for A', 'reply for A', 'thread-a');
  const tabB = slowIdleTab('concurrent-tab-b', 'question for B', 'reply for B', 'thread-b');
  await tabA.open();
  await tabB.open();
  await new Promise((r) => setTimeout(r, 50));
  // The agent request pacer (below) enforces a real minimum gap between
  // backend-touching dispatches, on purpose -- the account-wide rate limit
  // it exists to avoid doesn't care which tab a request is for. That's
  // orthogonal to what THIS test checks (no tab collision, no queue-wide
  // stall), so shrink it to a floor for this test only.
  const savedSpacing = agentPacer.spacingMs;
  const savedMinMs = agentPacer.minMs;
  agentPacer.minMs = 5;
  agentPacer.spacingMs = 5;
  try {
    const startedAt = Date.now();
    const [resultA, resultB] = await Promise.all([
      askChatgpt({ text: 'question for A', timeout_seconds: 10, pollMs: 20 }),
      askChatgpt({ text: 'question for B', timeout_seconds: 10, pollMs: 20 }),
    ]);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(resultA.reply, 'reply for A');
    assert.equal(resultB.reply, 'reply for B');
    assert.notEqual(resultA.thread_id, resultB.thread_id, 'both calls landed on the same tab/thread');
    // Serialized, this would take at least 2x the per-call reply delay.
    assert.ok(elapsedMs < 400, `expected the two calls to overlap, took ${elapsedMs}ms`);
    assert.equal(tabA.received.filter((a) => a === 'send_prompt').length, 1);
    assert.equal(tabB.received.filter((a) => a === 'send_prompt').length, 1);
  } finally {
    agentPacer.spacingMs = savedSpacing;
    agentPacer.minMs = savedMinMs;
    tabA.ws.close();
    tabB.ws.close();
  }
});

// The pacer is the actual fix for the account-wide rate limit ChatGPT itself
// applies (observed live 2026-09-17): it must force a real minimum gap
// between two backend-touching dispatches regardless of which tab or which
// logical ask_chatgpt call they belong to.
test('the agent request pacer enforces a minimum gap between backend-touching dispatches, across different tabs', async () => {
  const tab = fakeTab('pacer-tab', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') { state.thread = null; return reply({ ok: true, navigated: true }); }
      if (msg.action === 'send_prompt') { state.thread = 'pacer-thread'; return reply({ ok: true, thread_id: 'pacer-thread', dom_before: 0, messages_before: 0 }); }
      if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'paced reply', thread_id: 'pacer-thread' });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await tab.open();
  const savedSpacing = agentPacer.spacingMs;
  const savedMinMs = agentPacer.minMs;
  agentPacer.minMs = 150;
  agentPacer.spacingMs = 150;
  fs.rmSync(requestTimingPath, { force: true });
  try {
    await askChatgpt({ text: 'first', timeout_seconds: 10, pollMs: 20 });
    await askChatgpt({ text: 'second', timeout_seconds: 10, pollMs: 20 });
    const events = fs.readFileSync(requestTimingPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(events.length >= 2, 'expected at least the two send_prompt dispatches to be logged');
    // Each success shrinks the pacer's gap a little (AIMD), so compare each
    // gap against the spacing the pacer actually held right after the prior
    // dispatch (logged on that event), not a fixed constant.
    for (let i = 1; i < events.length; i++) {
      const gap = new Date(events[i].ts).getTime() - new Date(events[i - 1].ts).getTime();
      const requiredGap = events[i - 1].spacing_ms - 20; // small scheduling slack
      assert.ok(gap >= requiredGap, `expected >=${requiredGap}ms between "${events[i - 1].action}" and "${events[i].action}", got ${gap}ms`);
    }
  } finally {
    agentPacer.spacingMs = savedSpacing;
    agentPacer.minMs = savedMinMs;
    tab.ws.close();
  }
});

test('the agent request pacer widens its gap on a detected rate-limit signal and records it', async () => {
  const tab = fakeTab('rate-limit-tab', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') return reply({ ok: true, navigated: true });
      if (msg.action === 'send_prompt') { state.thread = 'rl-thread'; return reply({ ok: true, thread_id: 'rl-thread', dom_before: 0, messages_before: 0 }); }
      // api_checked:true simulates the real case: this get_reply actually
      // hit ChatGPT's backend (not a free DOM poll) and that's where the
      // rate-limit signal showed up.
      if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'ok', thread_id: 'rl-thread', visible_error: 'too_many_requests', api_checked: true, api_status: 429 });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await tab.open();
  const savedSpacing = agentPacer.spacingMs;
  const savedRateLimited = agentPacer.rateLimited;
  agentPacer.spacingMs = 50;
  try {
    await askChatgpt({ text: 'trips the limit', timeout_seconds: 10, pollMs: 20 });
    assert.ok(agentPacer.spacingMs > 50, `expected the gap to widen after a rate-limit signal, stayed at ${agentPacer.spacingMs}`);
    assert.ok(agentPacer.rateLimited > savedRateLimited, 'expected at least one rate-limit signal to be recorded');
    const lines = fs.readFileSync(requestTimingPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.action === 'get_reply' && l.rate_limited === true), 'expected the rate-limited get_reply to be logged');
  } finally {
    agentPacer.spacingMs = savedSpacing;
    agentPacer.rateLimited = savedRateLimited;
    tab.ws.close();
  }
});

test('a get_reply poll that never actually hits the API is not paced, counted, or logged as a real request', async () => {
  const tab = fakeTab('free-poll-tab', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') return reply({ ok: true, navigated: true });
      if (msg.action === 'send_prompt') { state.thread = 'free-poll-thread'; return reply({ ok: true, thread_id: 'free-poll-thread', dom_before: 0, messages_before: 0 }); }
      // No api_checked field at all -- a pure DOM read, exactly like the
      // vast majority of get_reply polls in real usage (the client only
      // actually hits the API roughly once per 10s per tab).
      if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'free', thread_id: 'free-poll-thread' });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await tab.open();
  fs.rmSync(requestTimingPath, { force: true });
  try {
    await askChatgpt({ text: 'free polls only', timeout_seconds: 10, pollMs: 20 });
    const lines = fs.existsSync(requestTimingPath) ? fs.readFileSync(requestTimingPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    assert.ok(lines.some((l) => l.action === 'send_prompt'), 'expected send_prompt itself to still be logged (always real)');
    assert.ok(!lines.some((l) => l.action === 'get_reply'), 'expected no free/unchecked get_reply to be logged as a real request');
  } finally {
    tab.ws.close();
  }
});

test('a real (api_checked) get_reply is logged with tab/agent/incognito context and the api status', async () => {
  const tab = fakeTab('context-tab', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') return reply({ ok: true, navigated: true });
      if (msg.action === 'send_prompt') { state.thread = 'context-thread'; return reply({ ok: true, thread_id: 'context-thread', dom_before: 0, messages_before: 0 }); }
      if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'checked', thread_id: 'context-thread', api_checked: true, api_status: 200, incognito: false });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await tab.open();
  fs.rmSync(requestTimingPath, { force: true });
  try {
    await askChatgpt({ text: 'real check', timeout_seconds: 10, pollMs: 20 });
    const lines = fs.readFileSync(requestTimingPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.action === 'get_reply');
    assert.ok(entry, 'expected the api_checked get_reply to be logged');
    assert.equal(entry.tab, 'context-'.slice(0, 8));
    assert.equal(entry.agent_tab, true);
    assert.equal(entry.incognito, false);
    assert.equal(entry.api_checked, true);
    assert.equal(entry.api_status, 200);
    assert.equal(typeof entry.requests_last_60s, 'number');
    assert.equal(typeof entry.requests_last_300s, 'number');
    assert.equal(typeof entry.in_flight, 'number');
  } finally {
    tab.ws.close();
  }
});

test('an authoritative Retry-After from a real 429 sets the pacer gap directly instead of only doubling blind', async () => {
  const tab = fakeTab('retry-after-tab', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') return reply({ ok: true, navigated: true });
      if (msg.action === 'send_prompt') { state.thread = 'ra-thread'; return reply({ ok: true, thread_id: 'ra-thread', dom_before: 0, messages_before: 0 }); }
      if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'ok', thread_id: 'ra-thread', api_checked: true, api_status: 429, api_retry_after_ms: 9000 });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await tab.open();
  const savedSpacing = agentPacer.spacingMs;
  agentPacer.spacingMs = 50;
  try {
    await askChatgpt({ text: 'honor retry-after', timeout_seconds: 10, pollMs: 20 });
    assert.ok(agentPacer.spacingMs >= 9000, `expected the pacer to adopt the server's own Retry-After (9000ms), got ${agentPacer.spacingMs}`);
  } finally {
    agentPacer.spacingMs = savedSpacing;
    tab.ws.close();
  }
});

// Auto-archive pushes thread_snapshot straight over the socket -- it never
// goes through dispatchToExtension/agentPacer, so before this it was
// invisible to request-timing.jsonl and the pacer's rate-limit reaction
// entirely, even though its own code comment already documented one prior
// incident from page activity alone. Found 2026-09-18 investigating a
// rate-limit spike that coincided with heavy multi-tab use, not any
// explicit ask_chatgpt call.
function connectRawTab(tab, { agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}&tab=${tab}${agent ? '&agent=1' : ''}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test('a dom_activity push is logged with zero cost to ChatGPT -- no dispatch, no pacing, just a timestamped record', async () => {
  const ws = await connectRawTab('dom-activity-tab', { agent: false });
  fs.rmSync(domActivityPath, { force: true });
  try {
    ws.send(JSON.stringify({ type: 'dom_activity', thread_id: 'thread-xyz', dom_key: 'thread-xyz|3|assistant|40', outcome: 'attempted' }));
    await new Promise((r) => setTimeout(r, 50));
    const lines = fs.readFileSync(domActivityPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.thread_id === 'thread-xyz');
    assert.ok(entry, 'expected the dom_activity push to be logged');
    assert.equal(entry.tab, 'dom-activ'.slice(0, 8));
    assert.equal(entry.agent_tab, false);
    assert.equal(entry.outcome, 'attempted');
    assert.equal(entry.dom_key, 'thread-xyz|3|assistant|40');
  } finally {
    ws.close();
  }
});

test('an auto-archive thread_snapshot is logged into the same request-timing timeline as agent calls', async () => {
  const ws = await connectRawTab('snapshot-tab', { agent: false });
  fs.rmSync(requestTimingPath, { force: true });
  try {
    ws.send(JSON.stringify({
      type: 'thread_snapshot',
      api_error_status: null,
      snapshot: { thread_id: 'auto-thread-1', title: 'Auto', messages: [{ role: 'user', text: 'hi' }] },
    }));
    await new Promise((r) => setTimeout(r, 50));
    const lines = fs.readFileSync(requestTimingPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.action === 'auto_capture');
    assert.ok(entry, 'expected the auto-archive push to be logged as auto_capture');
    assert.equal(entry.rate_limited, false);
    assert.equal(entry.tab, 'snapshot-'.slice(0, 8));
    assert.equal(typeof entry.requests_last_60s, 'number');
  } finally {
    ws.close();
  }
});

test('an auto-archive thread_snapshot carrying a real 429 widens the shared agentPacer too, not just its own log line', async () => {
  const ws = await connectRawTab('snapshot-429-tab', { agent: false });
  const savedSpacing = agentPacer.spacingMs;
  agentPacer.spacingMs = 50;
  try {
    ws.send(JSON.stringify({
      type: 'thread_snapshot',
      api_error_status: 429,
      snapshot: { thread_id: 'auto-thread-2', title: 'Auto 429', messages: [{ role: 'user', text: 'hi' }] },
    }));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(agentPacer.spacingMs > 50, `expected a real 429 from auto-archive to widen the shared pacer, stayed at ${agentPacer.spacingMs}`);
  } finally {
    agentPacer.spacingMs = savedSpacing;
    ws.close();
  }
});

// Regression: the finished-reply check requires the SAME done text on two
// consecutive polls (to rule out a mid-stream pause). If the first of those
// two lands right at the deadline, the old code gave up and reported a
// timeout even though it had just seen the real, finished reply -- observed
// live 2026-09-17 ("No finished reply within 90s (last seen: ...done:
// true...)"). The confirming poll must still run in that case.
test('ask_chatgpt confirms a done reply seen right at the deadline instead of reporting a false timeout', async () => {
  const agent = fakeTab('deadline-agent', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') { state.thread = null; return reply({ ok: true }); }
      if (msg.action === 'send_prompt') { state.thread = 'deadline-thread'; return reply({ ok: true, thread_id: state.thread, dom_before: 0, messages_before: 0 }); }
      if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'settled answer', thread_id: state.thread, message_count: 2 });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await agent.open();
  try {
    // pollMs=60 with a 50ms deadline: the FIRST get_reply poll (at t=60ms)
    // already lands past the deadline. The old code would already have
    // thrown by the time it observed this done:true reply.
    const result = await askChatgpt({ text: 'race the clock', timeout_seconds: 0.05, pollMs: 60 });
    assert.equal(result.reply, 'settled answer');
    assert.equal(result.thread_id, 'deadline-thread');
  } finally {
    agent.ws.close();
  }
});

test('ask_chatgpt recovers a new thread when navigation drops the send acknowledgement', async () => {
  const agent = fakeTab('nav-drop-agent', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') {
        state.thread = null;
        return reply({ ok: true, navigated: true });
      }
      if (msg.action === 'send_prompt') {
        state.thread = 'recovered-new-thread';
        return; // simulate the old page disappearing before its command result
      }
      if (msg.action === 'get_reply') {
        return reply({ ok: true, done: true, reply: 'Recovered complete answer', thread_id: state.thread, message_count: 2 });
      }
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await agent.open();
  await new Promise((r) => setTimeout(r, 50));
  try {
    const result = await askChatgpt({ text: 'survive navigation', timeout_seconds: 10, pollMs: 20, sendTimeoutMs: 50 });
    assert.equal(result.thread_id, 'recovered-new-thread');
    assert.equal(result.reply, 'Recovered complete answer');
  } finally {
    agent.ws.close();
  }
});

test('ask_chatgpt opens an agent tab when only Brian\'s tabs are connected, and fails clearly if it never connects', async () => {
  const human = fakeTab('human-tab-0006', { onCommand: async (msg, state, reply) => reply({ ok: false, error: 'should not be used' }) });
  await human.open();
  let opened = 0;
  setAgentTabOpener(async () => { opened++; });
  try {
    await assert.rejects(askChatgpt({ text: 'hi', timeout_seconds: 10, pollMs: 50, openWaitMs: 1500 }), /No idle agent ChatGPT tab/);
    assert.equal(opened, 1);
    assert.deepEqual(human.received, []);
  } finally {
    human.ws.close();
  }
});

test('ask_chatgpt can require a fresh dedicated tab even when an idle agent tab exists', async () => {
  const oldAgent = fakeTab('old-agent-tab', {
    agent: true,
    onCommand: async (msg, _state, reply) => reply({ ok: false, error: `old tab should not receive ${msg.action}` }),
  });
  await oldAgent.open();
  let newAgent;
  setAgentTabOpener(async () => {
    newAgent = fakeTab('fresh-agent-tab', {
      agent: true,
      onCommand: async (msg, state, reply) => {
        if (msg.action === 'navigate_home') { state.thread = null; return reply({ ok: true }); }
        if (msg.action === 'send_prompt') { state.thread = 'fresh-thread'; return reply({ ok: true, thread_id: state.thread, dom_before: 0, messages_before: 0 }); }
        if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'fresh answer', thread_id: state.thread, message_count: 2 });
        reply({ ok: false, error: `unexpected ${msg.action}` });
      },
    });
    await newAgent.open();
  });
  try {
    const result = await askChatgpt({ text: 'fresh task', fresh_tab: true, timeout_seconds: 10, pollMs: 20, openWaitMs: 2000 });
    assert.equal(result.thread_id, 'fresh-thread');
    assert.equal(result.reply, 'fresh answer');
    assert.ok(!oldAgent.received.includes('send_prompt'));
  } finally {
    oldAgent.ws.close();
    newAgent?.ws.close();
  }
});

test('ask_chatgpt uses the agent tab the broker opened for it', async () => {
  const agentTab = fakeTab('agent-tab-0007', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'send_prompt') return reply({ ok: true, thread_id: 't-7', dom_before: 0 });
      if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'from the new tab', thread_id: 't-7' });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  setAgentTabOpener(async () => { setTimeout(() => agentTab.open(), 300); });
  try {
    const r = await askChatgpt({ text: 'hi', timeout_seconds: 10, pollMs: 50, openWaitMs: 5000 });
    assert.equal(r.reply, 'from the new tab');
  } finally {
    agentTab.ws?.close();
  }
});

test('ask_chatgpt records operational evidence without prompt or reply content', async () => {
  const agentTab = fakeTab('agent-tab-observe', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'send_prompt') return reply({ ok: true, thread_id: 'observation-thread', dom_before: 1 });
      if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'this must not be recorded', thread_id: 'observation-thread', message_count: 3 });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await agentTab.open();
  try {
    await askChatgpt({ text: 'private prompt text', timeout_seconds: 10, pollMs: 20 });
    const events = fs.readFileSync(bridgeObservationsPath, 'utf8').trim().split('\n').map(JSON.parse);
    const event = events.at(-1);
    assert.equal(event.outcome, 'success');
    assert.equal(event.thread_id, 'observation-thread');
    assert.equal(event.prompt_chars, 'private prompt text'.length);
    assert.equal(event.history_message_count, 3);
    assert.equal(JSON.stringify(event).includes('private prompt text'), false);
    assert.equal(JSON.stringify(event).includes('this must not be recorded'), false);
  } finally {
    agentTab.ws.close();
  }
});

test('ask_chatgpt classifies a visible ChatGPT too-many-requests error', async () => {
  const agentTab = fakeTab('agent-tab-rate-limit', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'send_prompt') return reply({ ok: true, thread_id: 'rate-thread', dom_before: 0 });
      if (msg.action === 'get_reply') return reply({ ok: true, done: false, thread_id: 'rate-thread', message_count: 2, visible_error: 'too_many_requests' });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await agentTab.open();
  try {
    await assert.rejects(askChatgpt({ text: 'try once', timeout_seconds: 0.1, pollMs: 20 }), /No finished reply within/);
    const event = fs.readFileSync(bridgeObservationsPath, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(event.outcome, 'failed');
    assert.equal(event.failure_kind, 'rate_limited');
    assert.equal(event.visible_error, 'too_many_requests');
    assert.equal(event.thread_id, 'rate-thread');
  } finally {
    agentTab.ws.close();
  }
});

test('ask_chatgpt leaves an unobserved failure source unknown', async () => {
  const agentTab = fakeTab('agent-tab-unknown-failure', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'send_prompt') return reply({ ok: false, error: 'the page layout changed before the prompt could be sent' });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await agentTab.open();
  try {
    await assert.rejects(askChatgpt({ text: 'try once', timeout_seconds: 0.1, pollMs: 20 }), /page layout changed/);
    const event = fs.readFileSync(bridgeObservationsPath, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(event.failure_kind, 'unknown');
    assert.equal(event.visible_error, null);
  } finally {
    agentTab.ws.close();
  }
});

test('bridge observation report summarizes local outcomes and preserves raw thread IDs', () => {
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-observation-report-'));
  const observationDir = path.join(archiveDir, 'observations');
  fs.mkdirSync(observationDir, { recursive: true });
  fs.writeFileSync(path.join(observationDir, 'bridge-events.jsonl'), [
    { schema_version: 1, event_id: 'one', outcome: 'success', failure_kind: null, conversation_mode: 'new', thinking_level: 'unknown', duration_ms: 100, thread_id: 'raw-thread-one' },
    { schema_version: 1, event_id: 'two', outcome: 'failed', failure_kind: 'rate_limited', conversation_mode: 'continuing', thinking_level: 'unknown', duration_ms: 300, thread_id: 'raw-thread-two', started_at: '2026-09-16T00:00:00.000Z', ended_at: '2026-09-16T00:00:00.300Z', history_message_count: 18 },
  ].map(JSON.stringify).join('\n') + '\n');
  const output = execFileSync(process.execPath, ['scripts/bridge-observation-report.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, ARCHIVE_DIR: archiveDir },
    encoding: 'utf8',
  });
  const report = JSON.parse(output);
  assert.equal(report.events, 2);
  assert.deepEqual(report.by_outcome, { failed: 1, success: 1 });
  assert.equal(report.by_failure_kind.rate_limited, 1);
  assert.equal(report.rate_limited_events[0].thread_id, 'raw-thread-two');
});

test('untargeted "current chat" commands skip the agent tab when Brian has a tab open', async () => {
  const human = fakeTab('human-tab-0008', { onCommand: async (msg, state, reply) => reply({ ok: true, thread_id: 'brians-chat' }) });
  const agentTab = fakeTab('agent-tab-0009', { agent: true, onCommand: async (msg, state, reply) => reply({ ok: true, thread_id: 'agent-chat' }) });
  await human.open();
  await agentTab.open();
  try {
    const res = await authed('/api/current');
    const body = await res.json();
    assert.equal(body.thread_id, 'brians-chat');
    assert.deepEqual(agentTab.received, []);
  } finally {
    human.ws.close();
    agentTab.ws.close();
  }
});


const progress = (tab, done) => tab.ws.send(JSON.stringify({ type: 'bulk_archive_progress', done, total: 137, archived: done }));

test('a bulk archive whose tab disconnects for good ends the run instead of waiting 12 hours', async () => {
  const tab = fakeTab('bulk-tab-0004', { onCommand: async () => {} });
  await tab.open();
  const completion = waitForBulkComplete(10000);
  progress(tab, 2);
  await new Promise((r) => setTimeout(r, 100));
  tab.ws.close();
  const result = await completion;
  assert.match(result.fatal_error, /disconnected/);
  assert.equal(result.done, 2);
  const status = await (await authed('/api/archive-all/status')).json();
  assert.equal(status.running, false);
});

test('a bulk archive tab that reconnects and still reports busy is not declared dead', async () => {
  const tab = fakeTab('bulk-tab-0005', { busy: true, onCommand: async () => {} });
  await tab.open();
  const completion = waitForBulkComplete(10000);
  let settled = false;
  completion.then(() => { settled = true; });
  progress(tab, 5);
  await new Promise((r) => setTimeout(r, 100));
  tab.ws.close();
  await tab.open();                                  // same page, new socket
  await new Promise((r) => setTimeout(r, 600));      // well past the 200ms grace
  assert.equal(settled, false, 'a live archive was declared dead');
  tab.ws.send(JSON.stringify({ type: 'bulk_archive_complete', total: 137, archived: 137, failed: [] }));
  const result = await completion;
  assert.equal(result.fatal_error, undefined);
  tab.ws.close();
});

test('title matching prefers an exact title, otherwise every title containing the query', () => {
  const chats = [{ id: 'a', title: 'Evidence to Action' }, { id: 'b', title: 'Evidence to Action — part 2' }, { id: 'c', title: 'Groceries' }];
  assert.deepEqual(matchChatsByTitle(chats, 'evidence to action').map((c) => c.id), ['a']);
  assert.deepEqual(matchChatsByTitle(chats, 'EVIDENCE').map((c) => c.id), ['a', 'b']);
  assert.deepEqual(matchChatsByTitle(chats, 'nothing'), []);
  assert.deepEqual(matchChatsByTitle(chats, '  '), []);
});

test('ask_chatgpt continues the one chat whose title matches, and refuses an ambiguous title', async () => {
  const chats = [{ id: 'chat-1', title: 'Metamodel review' }, { id: 'chat-2', title: 'Budget 2026' }, { id: 'chat-3', title: 'Budget 2027' }];
  const human = fakeTab('human-tab-0010', { onCommand: async (msg, state, reply) => {
    if (msg.action === 'list_recent_chats') return reply({ ok: true, chats });
    reply({ ok: false, error: 'should not be used' });
  } });
  const agentTab = fakeTab('agent-tab-0011', {
    agent: true,
    onCommand: async (msg, state, reply, reopen) => {
      if (msg.action === 'list_recent_chats') return reply({ ok: true, chats });
      if (msg.action === 'navigate_to_thread') {
        reply({ ok: true, navigated: true });
        state.ws.close();
        state.thread = msg.thread_id;
        setTimeout(() => reopen(), 100);
        return;
      }
      if (msg.action === 'send_prompt') return reply({ ok: true, thread_id: state.thread, dom_before: 4 });
      if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'continued', thread_id: state.thread });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await human.open();
  await agentTab.open();
  try {
    await assert.rejects(askChatgpt({ text: 'hi', thread_title: 'budget', timeout_seconds: 10, pollMs: 50 }), /matches 2 chats.*chat-2.*chat-3/);
    await assert.rejects(askChatgpt({ text: 'hi', thread_title: 'no such chat', timeout_seconds: 10, pollMs: 50 }), /No chat among the 100 most recent/);
    const r = await askChatgpt({ text: 'hi', thread_title: 'metamodel', timeout_seconds: 10, pollMs: 50 });
    assert.equal(r.thread_id, 'chat-1');
    assert.equal(r.reply, 'continued');
    assert.ok(agentTab.received.includes('navigate_to_thread'));
    assert.ok(!agentTab.received.includes('navigate_home'));
  } finally {
    human.ws.close();
    agentTab.ws.close();
  }
});

test('opening the agent tab retries a transient failure and reports every attempt when all fail', async () => {
  let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw new Error('UtilAcceptVsock:273: accept4 failed 110'); };
  assert.deepEqual(await runOpenCommand('open', { delayMs: 10, exec: flaky }), { attempts: 2 });
  const broken = async () => { throw new Error('accept4 failed 110'); };
  await assert.rejects(runOpenCommand('open', { attempts: 3, delayMs: 10, exec: broken }), /failed 3 times: attempt 1: accept4 failed 110 \| attempt 2: .* \| attempt 3: /);
});
