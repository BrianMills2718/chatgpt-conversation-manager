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

before(async () => {
  process.env.PORT = '0';
  process.env.RENAMER_TOKEN = TOKEN;
  process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-server-test-'));
  const mod = await import('../server/index.js');
  server = mod.server;
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
