import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const TOKEN = 'pacer-state-test-token';
const previouslySavedAccount = 'saved-account-a@example.com';
const firstActiveAccount = 'active-account-b@example.com';
const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-pacer-state-'));
const pacerStatePath = path.join(archiveDir, 'observations', 'agent-pacer-state.json');
const sockets = [];
let mod;
let server;
let wsUrl;

before(async () => {
  process.env.PORT = '0';
  process.env.RENAMER_TOKEN = TOKEN;
  process.env.ARCHIVE_DIR = archiveDir;
  fs.mkdirSync(path.dirname(pacerStatePath), { recursive: true });
  fs.writeFileSync(pacerStatePath, JSON.stringify({
    '(default)': { spacingMs: 3000, rateLimited: 0, successes: 0 },
    [previouslySavedAccount]: { spacingMs: 12000, rateLimited: 2, successes: 4 },
  }));

  mod = await import('../server/index.js');
  server = mod.server;
  await new Promise((resolve) => (server.listening ? resolve() : server.listen(0, resolve)));
  wsUrl = `ws://127.0.0.1:${server.address().port}/extension?token=${TOKEN}`;
});

after(() => {
  for (const ws of sockets) ws.close();
  if (server?.listening) server.close();
});

test('saving one account after restart retains another account’s unloaded saved pacer', async () => {
  const activeEntry = mod.getPacerEntry(firstActiveAccount);
  activeEntry.pacer.minMs = 0;
  activeEntry.pacer.spacingMs = 0;
  let polls = 0;
  const tabToken = 'pacer-state-agent';
  const socket = new WebSocket(`${wsUrl}&tab=${tabToken}&agent=1`);
  sockets.push(socket);

  await new Promise((resolve, reject) => {
    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'identity',
        account: { email: firstActiveAccount, user_id: 'active-account-b', name: 'Account B' },
      }));
      setTimeout(resolve, 50);
    });
    socket.once('error', reject);
  });

  socket.on('message', (buffer) => {
    const message = JSON.parse(buffer.toString());
    if (message.type !== 'command') return;
    let result;
    if (message.action === 'get_tab') result = { busy: false, thread_id: null };
    else if (message.action === 'navigate_home') result = { navigated: true };
    else if (message.action === 'send_prompt') {
      result = { thread_id: 'pacer-state-thread', dom_before: 0, messages_before: 0 };
    } else if (message.action === 'get_reply') {
      if (polls++ === 0) {
        result = {
          done: true,
          reply: 'synthetic reply for the persistence test',
          thread_id: 'pacer-state-thread',
          visible_error: 'too_many_requests',
          api_checked: true,
          api_status: 429,
        };
      } else {
        result = { done: true, reply: 'synthetic reply for the persistence test', thread_id: 'pacer-state-thread', api_checked: false };
      }
    } else {
      result = { error: `unexpected action ${message.action}` };
    }
    socket.send(JSON.stringify({
      type: 'command_result',
      id: message.id,
      ok: true,
      tab: tabToken,
      agent: true,
      ...result,
    }));
  });

  const result = await mod.askChatgpt({
    text: 'exercise persisted state with a synthetic browser 429',
    account: firstActiveAccount,
    timeout_seconds: 5,
    pollMs: 2,
    confirmGraceMs: 100,
  });

  assert.equal(result.account, firstActiveAccount);
  assert.ok(polls > 0, 'the fake account should have returned a synthetic 429');
  const saved = JSON.parse(fs.readFileSync(pacerStatePath, 'utf8'));
  assert.deepEqual(saved[previouslySavedAccount], {
    spacingMs: 12000,
    rateLimited: 2,
    successes: 4,
  });
  assert.equal(saved[firstActiveAccount].rateLimited, 1);
});
