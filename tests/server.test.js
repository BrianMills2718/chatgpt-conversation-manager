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
let broadcastReloadTab;
let getPacerEntry;

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
  broadcastReloadTab = mod.broadcastReloadTab;
  getPacerEntry = mod.getPacerEntry;
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
    // A real tab reports its account right after connecting (content.js
    // reportIdentity); these fakes report none.
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'identity', account: null })); resolve(); });
    ws.on('message', async (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type !== 'command') return;
      state.received.push(msg.action);
      // Mirrors extension/content.js's requestContext: every real reply
      // carries tab/agent/incognito, so the fake tab does too by default
      // (a test can still override any of them via extra).
      const reply = (extra) => ws.send(JSON.stringify({ type: 'command_result', id: msg.id, tab, agent, incognito: false, ...extra }));
      if (msg.action === 'get_tab') return reply({ ok: true, tab, agent, busy: state.busy, thread_id: state.thread, ...(state.pageId ? { page_id: state.pageId } : {}) });
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

// The extension resolves generated images to inline base64 before it ever
// dispatches a reply back over the WebSocket (see content.js's
// resolveReplyImages) -- askChatgpt() just needs to carry that through
// untouched to whatever calls it, the same way it already carries `reply`.
test('ask_chatgpt carries resolved images through from the extension reply', async () => {
  const idle = fakeTab('idle-tab-image-0001', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') { reply({ ok: true, navigated: true }); return; }
      if (msg.action === 'send_prompt') { state.thread = 'img-thread-1'; return reply({ ok: true, thread_id: 'img-thread-1', dom_before: 0, messages_before: 0 }); }
      if (msg.action === 'get_reply') {
        return reply({
          ok: true, done: true, reply: 'Here is the legion banner:', thread_id: 'img-thread-1',
          images: [{ data: 'ZmFrZS1wbmctYnl0ZXM=', mimeType: 'image/png', name: null }],
        });
      }
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await idle.open();
  try {
    const r = await askChatgpt({ text: 'draw a legion banner', timeout_seconds: 10, pollMs: 20 });
    assert.equal(r.reply, 'Here is the legion banner:');
    assert.deepEqual(r.images, [{ data: 'ZmFrZS1wbmctYnl0ZXM=', mimeType: 'image/png', name: null }]);
  } finally {
    idle.ws.close();
  }
});

test('ask_chatgpt leaves images undefined for an ordinary text-only reply', async () => {
  const idle = fakeTab('idle-tab-noimg-0001', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') { reply({ ok: true, navigated: true }); return; }
      if (msg.action === 'send_prompt') { state.thread = 'text-thread-1'; return reply({ ok: true, thread_id: 'text-thread-1', dom_before: 0, messages_before: 0 }); }
      if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'just text', thread_id: 'text-thread-1' });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await idle.open();
  try {
    const r = await askChatgpt({ text: 'say hi', timeout_seconds: 10, pollMs: 20 });
    assert.equal(r.reply, 'just text');
    assert.equal(r.images, undefined);
  } finally {
    idle.ws.close();
  }
});

function connectTaggedSocket(tab, { agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}&tab=${tab}${agent ? '&agent=1' : ''}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// broadcastReloadTab reuses dispatchToExtensionRaw's own "No browser
// extension is connected" guard verbatim -- already exercised end to end by
// the POST /api/capture and POST /api/project 503 tests above, so it is not
// re-asserted here in isolation (this test file opens sockets throughout, and
// asserting a global zero-connections invariant at an arbitrary point in the
// run would just be fragile to test order, not to this function).

// The normal targeted dispatch path prefers Brian's own tabs and skips the
// agent tab when both are open (dispatchToExtensionRaw's untargeted-command
// rule) -- wrong for a reload, which must hit every stale tab, agent tab
// included, or the agent tab silently keeps running the old code.
test('broadcastReloadTab reaches every connected tab, human and agent alike, unlike a normal untargeted dispatch', async () => {
  const human = await connectTaggedSocket('human-reload-0001');
  const agentTab = await connectTaggedSocket('agent-reload-0001', { agent: true });
  const humanMessages = [];
  const agentMessages = [];
  human.on('message', (buf) => humanMessages.push(JSON.parse(buf.toString())));
  agentTab.on('message', (buf) => agentMessages.push(JSON.parse(buf.toString())));
  try {
    const result = broadcastReloadTab();
    // >= 2, not === 2: other tests in this file open and asynchronously close
    // sockets, so a not-yet-closed one from elsewhere can still be counted --
    // what this test must prove is that OUR human tab and OUR agent tab both
    // received it, not the exact total across the whole suite.
    assert.ok(result.sent_to >= 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0].action, 'reload_tab');
    assert.equal(agentMessages.length, 1);
    assert.equal(agentMessages[0].action, 'reload_tab');
  } finally {
    human.close();
    agentTab.close();
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
    const startedAt = performance.now();
    const [resultA, resultB] = await Promise.all([
      askChatgpt({ text: 'question for A', timeout_seconds: 10, pollMs: 20 }),
      askChatgpt({ text: 'question for B', timeout_seconds: 10, pollMs: 20 }),
    ]);
    const elapsedMs = performance.now() - startedAt;
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
    // Only paced requests (they carry spacing_ms); navigation log lines are not requests.
    const events = fs.readFileSync(requestTimingPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.spacing_ms != null);
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

// Real case 2026-09-26: concurrent asks landed on background (hidden) agent
// tabs; Send was clicked but the composer did not visibly clear in time, and
// the old extension threw even though ChatGPT received and answered the
// prompt. The extension now reports such a send as unconfirmed; the broker
// must keep watching each tab and return the real reply, sending each prompt
// exactly once.
test('concurrent asks whose hidden tabs cannot confirm the send still return the real replies, one send each', async () => {
  function hiddenTab(tab, expectedText, replyText, threadId) {
    let polls = 0;
    return fakeTab(tab, {
      agent: true,
      onCommand: async (msg, state, reply) => {
        if (msg.action === 'navigate_home') return reply({ ok: true, navigated: true });
        if (msg.action === 'send_prompt') {
          assert.equal(msg.text, expectedText);
          return reply({ ok: true, thread_id: null, dom_before: 0, messages_before: 0, send_confirmed: false, confirmed_by: null, visibility: 'hidden' });
        }
        if (msg.action === 'get_reply') {
          polls++;
          if (polls === 1) return reply({ ok: true, done: false, generating: false, thread_id: null, message_count: 0 });
          if (polls === 2) return reply({ ok: true, done: false, generating: true, thread_id: threadId, message_count: 1 });
          return reply({ ok: true, done: true, reply: replyText, thread_id: threadId, message_count: 2 });
        }
        reply({ ok: false, error: `unexpected ${msg.action}` });
      },
    });
  }
  const tabA = hiddenTab('hidden-tab-a', 'hidden question A', 'hidden reply A', 'hidden-thread-a');
  const tabB = hiddenTab('hidden-tab-b', 'hidden question B', 'hidden reply B', 'hidden-thread-b');
  await tabA.open();
  await tabB.open();
  await new Promise((r) => setTimeout(r, 50));
  try {
    const [a, b] = await Promise.all([
      askChatgpt({ text: 'hidden question A', timeout_seconds: 10, pollMs: 20 }),
      askChatgpt({ text: 'hidden question B', timeout_seconds: 10, pollMs: 20 }),
    ]);
    assert.deepEqual([a.reply, a.thread_id], ['hidden reply A', 'hidden-thread-a']);
    assert.deepEqual([b.reply, b.thread_id], ['hidden reply B', 'hidden-thread-b']);
    assert.equal(tabA.received.filter((x) => x === 'send_prompt').length, 1);
    assert.equal(tabB.received.filter((x) => x === 'send_prompt').length, 1);
  } finally {
    tabA.ws.close();
    tabB.ws.close();
  }
});

// Most logged ask failures are callers' timeout_seconds expiring while a slow
// thinking model is still answering a prompt that WAS sent. The old error said
// "check ChatGPT" with the send-time thread id (often "id not yet assigned"
// for a new chat) and no supported way to collect the answer, so callers
// resent and duplicated the question.
test('a timeout after a seen send names the conversation, says not to resend, and points at read_chatgpt_chat', async () => {
  const agentTab = fakeTab('agent-tab-slow-thinker', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'send_prompt') return reply({ ok: true, thread_id: null, dom_before: 0, messages_before: 0, send_confirmed: true, confirmed_by: 'thread_assigned' });
      if (msg.action === 'get_reply') return reply({ ok: true, done: false, generating: true, thread_id: 'slow-thread-1', message_count: 1 });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await agentTab.open();
  try {
    const err = await askChatgpt({ text: 'think hard', timeout_seconds: 0.1, pollMs: 20 }).then(() => null, (e) => e);
    assert.ok(err, 'expected a timeout');
    assert.match(err.message, /^No finished reply within 0\.1s, but the prompt WAS sent/);
    assert.match(err.message, /Do NOT resend/);
    assert.match(err.message, /read_chatgpt_chat\(thread="slow-thread-1"\)/);
    const event = fs.readFileSync(bridgeObservationsPath, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(event.failure_kind, 'timeout');
    assert.match(event.error_message, /prompt WAS sent/);
    assert.equal(event.error_message.includes('last seen'), false);
  } finally {
    agentTab.ws.close();
  }
});

// The other side of truthfulness: when Send was clicked but nothing ever shows
// the prompt reached ChatGPT, the error must not claim it was sent.
test('an unconfirmed send with no later evidence fails as unconfirmed, never as "sent"', async () => {
  const agentTab = fakeTab('agent-tab-never-confirmed', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'send_prompt') return reply({ ok: true, thread_id: null, dom_before: 0, messages_before: 0, send_confirmed: false, confirmed_by: null, visibility: 'hidden' });
      if (msg.action === 'get_reply') return reply({ ok: true, done: false, generating: false, thread_id: null, message_count: 0 });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await agentTab.open();
  try {
    const err = await askChatgpt({ text: 'did this go?', timeout_seconds: 0.1, pollMs: 20 }).then(() => null, (e) => e);
    assert.ok(err, 'expected a failure');
    assert.match(err.message, /^Could not confirm the prompt was sent/);
    assert.match(err.message, /tab visibility=hidden/);
    assert.match(err.message, /list_chatgpt_chats/);
    // Neither the new "WAS sent" claim nor the old "The message was sent" one.
    assert.equal(/WAS sent|The message was sent/.test(err.message), false);
    const event = fs.readFileSync(bridgeObservationsPath, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(event.failure_kind, 'send_unconfirmed');
  } finally {
    agentTab.ws.close();
  }
});

test('a send-step UI failure is classified browser_ui and its error text is recorded', async () => {
  const agentTab = fakeTab('agent-tab-no-send-button', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'send_prompt') return reply({ ok: false, error: 'no enabled send button found (tried [data-testid="send-button"], button[aria-label*="Send"]); nothing was sent.' });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await agentTab.open();
  try {
    await assert.rejects(askChatgpt({ text: 'secret prompt body', timeout_seconds: 1, pollMs: 20 }), /no enabled send button found/);
    const event = fs.readFileSync(bridgeObservationsPath, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(event.failure_kind, 'browser_ui');
    assert.match(event.error_message, /^no enabled send button found/);
    assert.equal(JSON.stringify(event).includes('secret prompt body'), false);
  } finally {
    agentTab.ws.close();
  }
});

test('read_chatgpt_chat transcripts say whether the latest reply is finished', async () => {
  const { formatChatTranscript } = await import('../server/index.js');
  const base = { thread_id: 't-late', title: 'Late', account: 'a@example.com', messages: [{ role: 'user', text: 'q' }], images: [] };
  assert.match(formatChatTranscript({ ...base, latest_reply_finished: false }), /latest reply: NOT finished/);
  assert.match(formatChatTranscript({ ...base, latest_reply_finished: true }), /latest reply: finished/);
  assert.equal(/latest reply/.test(formatChatTranscript(base)), false);
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
    // Title lookup also searches chats filed inside Projects (none here).
    if (msg.action === 'list_project_chats') return reply({ ok: true, projects: [] });
    reply({ ok: false, error: 'should not be used' });
  } });
  const agentTab = fakeTab('agent-tab-0011', {
    agent: true,
    onCommand: async (msg, state, reply, reopen) => {
      if (msg.action === 'list_recent_chats') return reply({ ok: true, chats });
      if (msg.action === 'list_project_chats') return reply({ ok: true, projects: [] });
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

// Real incident 2026-09-26/27: five serial asks each waited their full 900s
// although ChatGPT had finished within ~a minute. request-timing.jsonl shows
// the extension's API reads returning the finished reply (api_status 200 is
// only ever logged on its "done" path) about once a minute for 15 minutes.
// Cause: once a thread has a real id, only an API read can say "done", and
// the extension makes at most one API read per ~10s, so the 3s polls between
// two API reads come back as api_waiting/api_checked:false -- which the
// broker treated as "not done" and used to throw away the done candidate it
// was waiting to confirm. Two consecutive polls could then never both be
// done. These mocks replay that real sequence.
function apiCadenceTab(name, { replyText = 'the finished answer', endTurn, between = () => ({ api_checked: false, api_status: null }) } = {}) {
  let polls = 0;
  const tab = fakeTab(name, {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') { state.thread = null; return reply({ ok: true }); }
      if (msg.action === 'send_prompt') { state.thread = `${name}-thread`; return reply({ ok: true, thread_id: state.thread, dom_before: 0, messages_before: 0, send_confirmed: true, confirmed_by: 'composer_cleared' }); }
      if (msg.action === 'get_reply') {
        polls++;
        tab.polls = polls;
        // Every third poll is an actual API read (the extension's cooldown);
        // the ones between are free local reads that learn nothing.
        if (polls % 3 === 1) return reply({ ok: true, done: true, reply: replyText, thread_id: state.thread, message_count: 2, source: 'api', api_checked: true, api_status: 200, ...(endTurn === undefined ? {} : { end_turn: endTurn }) });
        return reply({ ok: true, done: false, generating: false, thread_id: state.thread, message_count: 0, reply: null, source: 'api_waiting', ...between(polls) });
      }
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  tab.polls = 0;
  return tab;
}

test('a finished API reply is confirmed even though the polls between API reads learn nothing', async () => {
  const agent = apiCadenceTab('api-cadence-agent');
  await agent.open();
  try {
    const result = await askChatgpt({ text: 'reply is ready', timeout_seconds: 2, pollMs: 10 });
    assert.equal(result.reply, 'the finished answer');
    // confirmed by the second API read, not by waiting out the timeout
    assert.ok(agent.polls <= 4, `expected confirmation on the next API read, took ${agent.polls} polls`);
  } finally {
    agent.ws.close();
  }
});

test('rate-limited API reads (HTTP 429) between two finished reads do not discard the finished reply', async () => {
  const agent = apiCadenceTab('api-429-agent', { between: () => ({ api_checked: true, api_status: 429 }) });
  await agent.open();
  try {
    const result = await askChatgpt({ text: 'reply is ready, account throttled', timeout_seconds: 2, pollMs: 10 });
    assert.equal(result.reply, 'the finished answer');
    assert.ok(agent.polls <= 4, `took ${agent.polls} polls`);
  } finally {
    agent.ws.close();
  }
});

test('a reply the backend marks end_turn is returned on the first API read, with no confirming read', async () => {
  const agent = apiCadenceTab('api-endturn-agent', { endTurn: true });
  await agent.open();
  try {
    const result = await askChatgpt({ text: 'single read', timeout_seconds: 2, pollMs: 10 });
    assert.equal(result.reply, 'the finished answer');
    assert.equal(agent.polls, 1);
  } finally {
    agent.ws.close();
  }
});

test('an API read that says "not finished" still discards an earlier done candidate', async () => {
  let polls = 0;
  const seq = [
    { done: true, reply: 'preamble only', source: 'api', api_checked: true, api_status: 200 },
    { done: false, source: 'api_waiting', api_checked: false, api_status: null },
    { done: false, source: 'api_waiting', api_checked: true, api_status: null }, // API: not finished yet
    { done: true, reply: 'preamble only\n\nfull answer', source: 'api', api_checked: true, api_status: 200 },
    { done: false, source: 'api_waiting', api_checked: false, api_status: null },
    { done: true, reply: 'preamble only\n\nfull answer', source: 'api', api_checked: true, api_status: 200 },
  ];
  const agent = fakeTab('api-reset-agent', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') { state.thread = null; return reply({ ok: true }); }
      if (msg.action === 'send_prompt') { state.thread = 'reset-thread'; return reply({ ok: true, thread_id: state.thread, dom_before: 0, messages_before: 0 }); }
      if (msg.action === 'get_reply') return reply({ ok: true, generating: false, thread_id: state.thread, message_count: 0, ...seq[Math.min(polls++, seq.length - 1)] });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await agent.open();
  try {
    const result = await askChatgpt({ text: 'multi-part answer', timeout_seconds: 2, pollMs: 10 });
    assert.equal(result.reply, 'preamble only\n\nfull answer');
  } finally {
    agent.ws.close();
  }
});

test('get_reply is told the prompt so the extension can find our turn when its message baseline is unknown', async () => {
  const seen = [];
  const agent = fakeTab('expected-agent', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') { state.thread = null; return reply({ ok: true }); }
      if (msg.action === 'send_prompt') { state.thread = 'expected-thread'; return reply({ ok: true, thread_id: state.thread, dom_before: 0, messages_before: null }); }
      if (msg.action === 'get_reply') { seen.push(msg); return reply({ ok: true, done: true, reply: 'r', thread_id: state.thread, source: 'api', end_turn: true }); }
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await agent.open();
  try {
    await askChatgpt({ text: '  What is   the answer?  ', timeout_seconds: 2, pollMs: 10 });
    assert.equal(seen[0].expected, 'What is   the answer?');
    assert.equal(seen[0].messages_before, null);
  } finally {
    agent.ws.close();
  }
});

test('an unconfirmed done candidate past the deadline is bounded, not polled forever', async () => {
  let polls = 0;
  const agent = fakeTab('grace-agent', {
    agent: true,
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'navigate_home') { state.thread = null; return reply({ ok: true }); }
      if (msg.action === 'send_prompt') { state.thread = 'grace-thread'; return reply({ ok: true, thread_id: state.thread, dom_before: 0, messages_before: 0 }); }
      if (msg.action === 'get_reply') {
        polls++;
        if (polls === 1) return reply({ ok: true, done: true, reply: 'once', thread_id: state.thread, source: 'api', api_checked: true, api_status: 200 });
        return reply({ ok: true, done: false, generating: false, thread_id: state.thread, source: 'api_waiting', api_checked: true, api_status: 429 });
      }
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await agent.open();
  try {
    const started = performance.now();
    const err = await askChatgpt({ text: 'throttled forever', timeout_seconds: 0.05, pollMs: 10, confirmGraceMs: 200 }).then(() => null, (e) => e);
    assert.ok(err, 'expected a timeout');
    assert.match(err.message, /prompt WAS sent/);
    assert.ok(performance.now() - started < 2000, 'the confirmation grace must be bounded');
  } finally {
    agent.ws.close();
  }
});

// 2026-09-27: two continuation asks failed with "no ChatGPT composer found"
// on a page that had been loaded for ~2 minutes (the pacer's wait) and never
// reloaded on its own. The extension throws that before typing anything, and
// says so (nothing_sent + the page instance it looked at), so the broker
// reloads that tab once and sends again on the fresh page.
function noComposerTab(name, { thread, composerAfterReloads = 1, bannerVisible = false }) {
  let reloads = 0;
  const sends = [];
  const tab = fakeTab(name, {
    agent: true,
    thread,
    onCommand: async (msg, state, reply, reopen) => {
      if (msg.action === 'reload_tab') {
        reloads++;
        reply({ ok: true, reloaded: true });
        state.ws.close();
        setTimeout(() => { state.pageId = `page-${reloads + 1}`; reopen(); }, 100);   // same tab token, new page instance
        return;
      }
      if (msg.action === 'send_prompt') {
        sends.push(state.pageId);
        if (reloads < composerAfterReloads) {
          return reply({ ok: false, error: 'no ChatGPT composer found (tried #prompt-textarea); nothing was typed or sent.',
            stage: 'no_composer', nothing_sent: true, page_id: state.pageId, visible_error: bannerVisible ? 'too_many_requests' : null });
        }
        return reply({ ok: true, thread_id: state.thread, dom_before: 2, messages_before: 2, send_confirmed: true });
      }
      if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'answer after reload', thread_id: state.thread, source: 'api', api_checked: true, api_status: 200, end_turn: true });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  tab.state = { get reloads() { return reloads; }, sends };
  return tab;
}

test('a continuation whose page never shows a composer is reloaded once and sent on the fresh page', async () => {
  const tab = noComposerTab('no-composer-once', { thread: 'cont-thread-1' });
  tab.pageId = 'page-1';
  await tab.open();
  try {
    const r = await askChatgpt({ text: 'continue please', thread_id: 'cont-thread-1', timeout_seconds: 5, pollMs: 10 });
    assert.equal(r.reply, 'answer after reload');
    assert.equal(tab.state.reloads, 1);
    // one send on the stale page (nothing typed), one on the reloaded page
    assert.deepEqual(tab.state.sends, ['page-1', 'page-2']);
  } finally {
    tab.ws.close();
  }
});

test('a composer that is still missing after the one reload fails truthfully: bounded, and says nothing was sent', async () => {
  const tab = noComposerTab('no-composer-twice', { thread: 'cont-thread-2', composerAfterReloads: 99 });
  tab.pageId = 'page-1';
  await tab.open();
  try {
    const err = await askChatgpt({ text: 'continue please', thread_id: 'cont-thread-2', timeout_seconds: 5, pollMs: 10 }).then(() => null, (e) => e);
    assert.ok(err, 'expected a failure');
    assert.match(err.message, /no ChatGPT composer found/);
    assert.match(err.message, /reloaded the tab once/);
    assert.match(err.message, /nothing was typed or sent/i);
    assert.equal(tab.state.reloads, 1, 'recovery must be bounded to one reload');
    assert.equal(tab.state.sends.length, 2);
    assert.ok(!tab.received.includes('get_reply'), 'must not poll for a reply to a prompt that was never sent');
  } finally {
    tab.ws.close();
  }
});

test('a missing composer with ChatGPT\'s rate-limit banner showing is not reloaded into the throttle', async () => {
  const tab = noComposerTab('no-composer-banner', { thread: 'cont-thread-3', bannerVisible: true });
  tab.pageId = 'page-1';
  await tab.open();
  try {
    const err = await askChatgpt({ text: 'continue please', thread_id: 'cont-thread-3', timeout_seconds: 5, pollMs: 10 }).then(() => null, (e) => e);
    assert.ok(err, 'expected a failure');
    assert.match(err.message, /nothing was typed or sent/i);
    assert.equal(tab.state.reloads, 0);
    assert.equal(tab.state.sends.length, 1);
  } finally {
    tab.ws.close();
  }
});

test('a send failure that does not prove nothing was typed is never retried (no duplicate prompt)', async () => {
  const tab = fakeTab('no-proof-agent', {
    agent: true,
    thread: 'cont-thread-4',
    onCommand: async (msg, state, reply) => {
      // An older extension (no nothing_sent/page_id fields) reporting the same text.
      if (msg.action === 'send_prompt') return reply({ ok: false, error: 'no ChatGPT composer found (tried #prompt-textarea); the page layout may have changed.' });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await tab.open();
  try {
    await assert.rejects(askChatgpt({ text: 'continue please', thread_id: 'cont-thread-4', timeout_seconds: 5, pollMs: 10 }), /no ChatGPT composer found/);
    assert.deepEqual(tab.received.filter((a) => a !== 'get_tab'), ['send_prompt']);
  } finally {
    tab.ws.close();
  }
});

// Both 2026-09-27 failures navigated 10-13s after ChatGPT answered HTTP 429,
// then sat ~2 minutes in the pacer before sending. The page load is itself a
// request for the conversation, so the pacer's wait belongs before it, and
// the send then follows the fresh page without a second full wait.
test('a continuation waits out the pacer gap before navigating, not between navigation and send', async () => {
  // Monotonic time: the wall clock on WSL steps ~3.6s every ~30s, which made
  // this test fail about 1 run in 6 when it measured with Date.now().
  const at = {};
  const tab = fakeTab('pace-nav-agent', {
    agent: true,
    thread: 'somewhere-else',
    onCommand: async (msg, state, reply, reopen) => {
      at[msg.action] ??= performance.now();
      if (msg.action === 'navigate_to_thread') {
        reply({ ok: true, navigated: true });
        state.ws.close();
        state.thread = msg.thread_id;
        setTimeout(() => reopen(), 50);
        return;
      }
      if (msg.action === 'send_prompt') return reply({ ok: true, thread_id: state.thread, dom_before: 2, messages_before: 2, send_confirmed: true });
      if (msg.action === 'get_reply') return reply({ ok: true, done: true, reply: 'paced', thread_id: state.thread, source: 'api', api_checked: true, api_status: 200, end_turn: true });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await tab.open();
  const entry = getPacerEntry('(default)');
  entry.pacer.minMs = 1500;
  entry.pacer.spacingMs = 1500;
  entry.lastRequestAt = performance.now();
  const started = performance.now();
  try {
    const r = await askChatgpt({ text: 'continue', thread_id: 'paced-thread', timeout_seconds: 5, pollMs: 10 });
    assert.equal(r.reply, 'paced');
    assert.ok(at.navigate_to_thread - started >= 1450, `navigated ${at.navigate_to_thread - started}ms after the last request; the pacer gap is 1500ms`);
    // ~700ms is waitForTab's own poll interval; a second pacer wait would make it ~1500ms
    assert.ok(at.send_prompt - at.navigate_to_thread < 1200, `send waited ${at.send_prompt - at.navigate_to_thread}ms after the page loaded`);
  } finally {
    tab.ws.close();
  }
});

test('a reload that never brings the page back fails within its bound and still says nothing was sent', async () => {
  const tab = fakeTab('no-composer-no-return', {
    agent: true,
    thread: 'cont-thread-5',
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'reload_tab') { reply({ ok: true, reloaded: true }); state.ws.close(); return; }   // never reconnects
      if (msg.action === 'send_prompt') return reply({ ok: false, error: 'no ChatGPT composer found (tried #prompt-textarea); nothing was typed or sent.', stage: 'no_composer', nothing_sent: true, page_id: 'page-1' });
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  tab.pageId = 'page-1';
  await tab.open();
  // An earlier test's opener would open its own fake tab; here no tab opens.
  setAgentTabOpener(async () => {});
  try {
    // openWaitMs: after this tab is given up there is no other one to move to.
    const err = await askChatgpt({ text: 'continue please', thread_id: 'cont-thread-5', timeout_seconds: 5, pollMs: 10, openWaitMs: 500 }).then(() => null, (e) => e);
    assert.ok(err, 'expected a failure');
    assert.match(err.message, /Reloading the tab to recover failed/);
    assert.match(err.message, /Nothing was typed or sent/);
    assert.match(err.message, /No other agent tab became available/);
    assert.equal(err.sent, false);
    assert.deepEqual(tab.received.filter((a) => a !== 'get_tab'), ['send_prompt', 'reload_tab']);
  } finally {
    tab.ws.close();
  }
});

// 2026-09-27: a continuation returned the previous answer followed by the new
// one. The tab ran extension 0.7.2, whose failed (HTTP 429) pre-send read fell
// back to the hidden tab's DOM count of 0. Now a continuation without that
// count is not sent (nothing_sent, stage no_baseline) and is retried once
// after the pacer gap the 429 widened.
function noBaselineTab(name, { failures }) {
  const sends = [];
  const tab = fakeTab(name, {
    agent: true,
    thread: 'baseline-thread',
    onCommand: async (msg, state, reply) => {
      if (msg.action === 'send_prompt') {
        sends.push(performance.now());
        if (sends.length <= failures) {
          return reply({ ok: false, error: 'could not read conversation baseline-thread before sending (backend-api conversation fetch failed: HTTP 429), so its reply could not be told apart from earlier ones; nothing was typed or sent.',
            stage: 'no_baseline', nothing_sent: true, page_id: 'page-1', api_status: 429, api_retry_after_ms: null });
        }
        return reply({ ok: true, thread_id: state.thread, dom_before: 0, messages_before: 2, send_confirmed: true });
      }
      if (msg.action === 'get_reply') {
        assert.equal(msg.messages_before, 2, 'the reply must be read against the known pre-send count');
        return reply({ ok: true, done: true, reply: 'only the new answer', thread_id: state.thread, source: 'api', api_checked: true, api_status: 200, end_turn: true });
      }
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  tab.sends = sends;
  return tab;
}

test('a continuation refused for an unreadable baseline is resent once after the widened pacer gap, without a reload', async () => {
  const tab = noBaselineTab('no-baseline-once', { failures: 1 });
  await tab.open();
  try {
    const r = await askChatgpt({ text: 'round two', thread_id: 'baseline-thread', timeout_seconds: 5, pollMs: 10 });
    assert.equal(r.reply, 'only the new answer');
    assert.equal(tab.sends.length, 2);
    assert.ok(tab.sends[1] - tab.sends[0] >= 900, `resent ${tab.sends[1] - tab.sends[0]}ms later; the 429 set a >=1000ms gap`);
    assert.ok(!tab.received.includes('reload_tab'));
  } finally {
    tab.ws.close();
  }
});

test('a continuation whose baseline stays unreadable fails truthfully after one retry, never polling for a reply', async () => {
  const tab = noBaselineTab('no-baseline-twice', { failures: 99 });
  await tab.open();
  try {
    const err = await askChatgpt({ text: 'round two', thread_id: 'baseline-thread', timeout_seconds: 5, pollMs: 10 }).then(() => null, (e) => e);
    assert.ok(err, 'expected a failure');
    assert.match(err.message, /retried once after the rate-limit gap/);
    assert.match(err.message, /Nothing was typed or sent/);
    assert.equal(tab.sends.length, 2);
    assert.ok(!tab.received.includes('get_reply'));
  } finally {
    tab.ws.close();
  }
});

test('each tab\'s running extension version is visible next to the version on disk', async () => {
  const ws = new WebSocket(`${wsUrl}&tab=version-tab-0001&v=0.0.1-test`);
  await new Promise((resolve) => ws.on('open', resolve));
  try {
    await new Promise((r) => setTimeout(r, 50));
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.ok(health.extension_versions_running.includes('0.0.1-test'), JSON.stringify(health));
    assert.notEqual(health.extension_version, '0.0.1-test');
  } finally {
    ws.close();
  }
});

test('a tab whose extension background worker did not answer is visible in /health', async () => {
  // Without a background worker the extension cannot reload itself onto a new
  // version (2026-09-26/27: 0.7.2-0.7.5 each sat on disk unloaded, silently).
  const dead = new WebSocket(`${wsUrl}&tab=bg-dead-tab-0001&v=0.7.6`);
  const alive = new WebSocket(`${wsUrl}&tab=bg-live-tab-0001&v=0.7.6`);
  await Promise.all([dead, alive].map((ws) => new Promise((resolve) => ws.on('open', resolve))));
  try {
    dead.send(JSON.stringify({ type: 'background_status', ok: false, error: 'Could not establish connection. Receiving end does not exist.' }));
    alive.send(JSON.stringify({ type: 'background_status', ok: true, version: '0.7.6' }));
    await new Promise((r) => setTimeout(r, 50));
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.ok(Array.isArray(health.extension_background_ok), JSON.stringify(health));
    assert.ok(health.extension_background_ok.includes(false), JSON.stringify(health));
    assert.ok(health.extension_background_ok.includes(true), JSON.stringify(health));
  } finally {
    dead.close();
    alive.close();
  }
});
