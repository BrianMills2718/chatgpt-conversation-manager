import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const TOKEN = 'test-token-123';
let baseUrl;
let wsUrl;
let server;
let askChatgpt;

before(async () => {
  process.env.PORT = '0';
  process.env.RENAMER_TOKEN = TOKEN;
  process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-server-test-'));
  const mod = await import('../server/index.js');
  server = mod.server;
  askChatgpt = mod.askChatgpt;
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  wsUrl = `ws://127.0.0.1:${server.address().port}/extension?token=${TOKEN}`;
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

function fakeTab(tab, { busy = false, thread = null, onCommand }) {
  const state = { busy, thread, received: [], ws: null };
  const open = () => new Promise((resolve) => {
    const ws = new WebSocket(`${wsUrl}&tab=${tab}`);
    state.ws = ws;
    ws.on('open', resolve);
    ws.on('message', async (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type !== 'command') return;
      state.received.push(msg.action);
      const reply = (extra) => ws.send(JSON.stringify({ type: 'command_result', id: msg.id, ...extra }));
      if (msg.action === 'get_tab') return reply({ ok: true, tab, busy: state.busy, thread_id: state.thread });
      if (state.busy && ['navigate_home', 'navigate_to_thread', 'send_prompt'].includes(msg.action)) {
        return reply({ ok: false, error: 'busy: a bulk archive is running in this tab' });
      }
      await onCommand(msg, state, reply, open);
    });
  });
  state.open = open;
  return state;
}

test('ask_chatgpt uses the idle tab, starts a new chat, and waits for the finished reply', async () => {
  const busy = fakeTab('busy-tab-0001', { busy: true, thread: 'archive-thread', onCommand: async () => {} });
  let polls = 0;
  const idle = fakeTab('idle-tab-0002', {
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
        return reply({ ok: true, thread_id: 'new-thread-123', dom_before: 0 });
      }
      if (msg.action === 'get_reply') {
        polls++;
        assert.equal(msg.dom_before, 0);
        if (polls === 1) return reply({ ok: true, done: false, generating: true });
        if (polls === 2) return reply({ ok: true, done: true, reply: 'hello ba', thread_id: 'new-thread-123' });   // paused mid-stream
        return reply({ ok: true, done: true, reply: 'hello back', thread_id: 'new-thread-123' });
      }
      reply({ ok: false, error: `unexpected ${msg.action}` });
    },
  });
  await busy.open();
  await idle.open();
  try {
    const r = await askChatgpt({ text: 'hello from an agent', timeout_seconds: 20, pollMs: 50 });
    assert.equal(r.reply, 'hello back');
    assert.equal(r.thread_id, 'new-thread-123');
    assert.ok(polls >= 4, 'it returned before the same finished text was seen twice');
    assert.deepEqual(busy.received.filter((a) => a !== 'get_tab'), [], 'the busy tab received a navigation or send');
    assert.ok(idle.received.includes('navigate_home') && idle.received.includes('send_prompt'));
  } finally {
    busy.ws.close();
    idle.ws.close();
  }
});

test('ask_chatgpt refuses clearly when every tab is busy archiving', async () => {
  const busy = fakeTab('busy-tab-0003', { busy: true, onCommand: async () => {} });
  await busy.open();
  try {
    await assert.rejects(askChatgpt({ text: 'hi', timeout_seconds: 10, pollMs: 50 }), /No idle ChatGPT tab/);
    assert.deepEqual(busy.received, ['get_tab']);
  } finally {
    busy.ws.close();
  }
});

