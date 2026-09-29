// A tab-targeted command must survive the tab's own reload/navigation.
// Own broker instance so these tabs never leak into other test files.
//
// Live case (2026-09-29 05:30:37Z): an ask continuing an old conversation
// navigated the agent tab; the page reloaded and its new socket connected
// 65 ms before it reported its account. send_prompt, targeted at that tab and
// account, was dispatched in that gap and failed at once with "tab ... is not
// connected (closed, or still reloading)" -- and the ask reported
// sent=unknown although no send command had ever left the broker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const TOKEN = 'tab-reconnect-token';
let mod, server, wsUrl;
const sockets = [];

before(async () => {
  process.env.PORT = '0';
  process.env.RENAMER_TOKEN = TOKEN;
  process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-reconnect-'));
  process.env.TAB_RECONNECT_WAIT_MS = '3000';
  mod = await import('../server/index.js');
  server = mod.server;
  await new Promise((resolve) => (server.listening ? resolve() : server.listen(0, resolve)));
  wsUrl = `ws://127.0.0.1:${server.address().port}/extension?token=${TOKEN}`;
  mod.agentPacer.minMs = 0; mod.agentPacer.spacingMs = 0;
});
after(() => { for (const ws of sockets) ws.close(); server.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Connects a socket for `token`; reports `email` after `identityDelayMs`.
function connect(token, email, { agent = true, identityDelayMs = 0, handlers = {} } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsUrl}&tab=${token}${agent ? '&agent=1' : ''}`);
    sockets.push(ws);
    ws.on('open', () => {
      setTimeout(() => ws.send(JSON.stringify({ type: 'identity', account: { email, user_id: `u-${email}`, name: email } })), identityDelayMs);
      resolve(ws);
    });
    ws.on('message', async (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type !== 'command') return;
      const h = handlers[msg.action];
      const reply = (extra) => ws.send(JSON.stringify({ type: 'command_result', id: msg.id, tab: token, agent, ...extra }));
      if (!h) return reply({ ok: false, error: `unhandled ${msg.action}` });
      try { reply({ ok: true, ...(await h(msg, ws)) }); } catch (err) { reply({ ok: false, error: err.message }); }
    });
  });
}

test('a command targeted at a reloading tab waits for it to reconnect and identify', async () => {
  const email = 'reload@example.com';
  const first = await connect('reload-tab-1', email);
  await sleep(50);
  first.close();
  await sleep(50);
  // Reconnect 300 ms later, and report the account 150 ms after that.
  const back = sleep(300).then(() => connect('reload-tab-1', email, { identityDelayMs: 150, handlers: { get_tab: () => ({ busy: false }) } }));
  const r = await mod.dispatchToExtension({ action: 'get_tab' }, 5000, { tab: 'reload-tab-1', account: email });
  assert.equal(r.ok, true);
  (await back).close();
});

test('a targeted command still fails loudly when the tab never comes back', async () => {
  await assert.rejects(
    mod.dispatchToExtension({ action: 'get_tab' }, 500, { tab: 'gone-tab-1' }),
    /is not connected|No browser extension is connected/,
  );
});

test('an ask that fails before any send command left the broker reports sent=no', async () => {
  const email = 'nosend@example.com';
  await connect('nosend-tab-1', email, {
    handlers: {
      get_tab: () => ({ busy: false, thread_id: null }),
      navigate_to_thread: () => { throw new Error('navigation failed'); },
    },
  });
  await sleep(50);
  const err = await mod.askChatgpt({ text: 'never typed', thread_id: 'abcdef12-0000-0000-0000-000000000000', account: email, timeout_seconds: 1, pollMs: 20 })
    .then(() => null, (e) => e);
  assert.ok(err, 'the ask should fail');
  assert.equal(err.sent, false, `expected sent=false, got ${err.sent} (${err.message})`);
});
