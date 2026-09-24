// Multi-account routing and read-without-sending. Separate file (own broker
// instance, own tabs) so tabs from server.test.js never leak into these.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const TOKEN = 'multi-account-token';
let mod, server, wsUrl;
const sockets = [];

before(async () => {
  process.env.PORT = '0';
  process.env.RENAMER_TOKEN = TOKEN;
  process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-multi-'));
  mod = await import('../server/index.js');
  server = mod.server;
  await new Promise((resolve) => (server.listening ? resolve() : server.listen(0, resolve)));
  wsUrl = `ws://127.0.0.1:${server.address().port}/extension?token=${TOKEN}`;
  mod.agentPacer.minMs = 0; mod.agentPacer.spacingMs = 0;
});
after(() => { for (const ws of sockets) ws.close(); server.close(); });

// A fake tab signed into `email`, answering commands through `handlers`.
function tab(token, email, { agent = false, handlers = {} } = {}) {
  const received = [];
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsUrl}&tab=${token}${agent ? '&agent=1' : ''}`);
    sockets.push(ws);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'identity', account: email ? { email, user_id: `user-${email}`, name: email } : null }));
      setTimeout(() => resolve({ ws, received }), 50);
    });
    ws.on('message', async (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type !== 'command') return;
      received.push(msg);
      const h = handlers[msg.action];
      const reply = (extra) => ws.send(JSON.stringify({ type: 'command_result', id: msg.id, tab: token, agent, ...extra }));
      if (!h) return reply({ ok: false, error: `unhandled ${msg.action}` });
      try { reply({ ok: true, ...(await h(msg)) }); } catch (err) { reply({ ok: false, error: err.message }); }
    });
  });
}

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

test('connections report the account each tab is signed into', async () => {
  await tab('aaaaaaaa-1', 'work@example.com', { agent: true });
  await tab('bbbbbbbb-1', 'personal@example.com');
  const rows = mod.listConnections();
  const byTab = Object.fromEntries(rows.map((r) => [r.tab, r]));
  assert.equal(byTab['aaaaaaaa'].account, 'work@example.com');
  assert.equal(byTab['aaaaaaaa'].agent, true);
  assert.equal(byTab['bbbbbbbb'].account, 'personal@example.com');
  assert.equal(byTab['bbbbbbbb'].agent, false);
});

test('read_chatgpt_chat finds the conversation on whichever account owns it and saves its images', async () => {
  const owned = { thread_id: 'conv-owned-by-c', title: 'Tomodachi mockups',
    messages: [{ message_id: 'm1', role: 'user', text: 'draw every tab' }, { message_id: 'm2', role: 'tool', text: '' }],
    images: [{ message_id: 'm2', role: 'tool', asset_pointer: 'sediment://file_1', data: PNG_B64, mimeType: 'image/png' },
             { message_id: 'm2', role: 'tool', asset_pointer: 'sediment://file_2', error: 'file download-url fetch failed: HTTP 404' }],
    account: { email: 'third@example.com' } };
  const wrong = await tab('cccccccc-1', 'other@example.com', { handlers: { read_conversation: () => { throw new Error('conversation fetch failed: HTTP 404'); } } });
  const right = await tab('dddddddd-1', 'third@example.com', { handlers: { read_conversation: () => owned } });
  const r = await mod.readChatgptChat({ thread: 'https://chatgpt.com/g/g-p-123/c/conv-owned-by-c', account: null });
  assert.equal(r.thread_id, 'conv-owned-by-c');
  assert.equal(r.account, 'third@example.com');
  assert.equal(right.received[0].thread_id, 'conv-owned-by-c');
  assert.equal(right.received[0].action, 'read_conversation');
  assert.ok(wrong.received.length <= 1);
  // The resolved image is on disk with its bytes; the failed one is reported, not dropped.
  assert.equal(fs.readFileSync(r.images[0].path).toString(), 'fake-png-bytes');
  assert.equal(r.images[1].path, null);
  const transcript = mod.formatChatTranscript(r);
  assert.match(transcript, /draw every tab/);
  assert.match(transcript, /\[image saved: .*01-m2\.png\]/);
  assert.match(transcript, /\[image unavailable: file download-url fetch failed: HTTP 404\]/);
});

test('an explicit account routes only to that account, and a missing account fails loudly naming what is connected', async () => {
  const e = await tab('eeeeeeee-1', 'routed@example.com', { handlers: { read_conversation: (m) => ({ thread_id: m.thread_id, title: 't', messages: [], images: [], account: { email: 'routed@example.com' } }) } });
  const r = await mod.readChatgptChat({ thread: 'abc-123', account: 'ROUTED@example.com' });
  assert.equal(r.account, 'routed@example.com');
  assert.equal(e.received.length, 1);
  await assert.rejects(() => mod.readChatgptChat({ thread: 'abc-123', account: 'nobody@example.com' }), /No connected ChatGPT tab is signed into nobody@example.com\. Connected accounts: .*routed@example.com/);
});

test('list includes chats inside Projects, merged newest first, from the requested account only', async () => {
  const f = await tab('ffffffff-1', 'lister@example.com', { handlers: {
    list_recent_chats: () => ({ chats: [{ id: 'main-old', title: 'Old main chat', update_time: '2026-09-23T10:00:00Z' }] }),
    list_project_chats: () => ({ projects: [{ project_id: 'g-p-1', project_name: 'DoDAF', chats: [
      { id: 'proj-new', title: 'Tomodachi image set', update_time: '2026-09-24T20:00:00Z', project_id: 'g-p-1', project_name: 'DoDAF' },
      { id: 'main-old', title: 'Old main chat', update_time: '2026-09-23T10:00:00Z', project_id: 'g-p-1', project_name: 'DoDAF' }] }] }),
  } });
  const chats = await mod.listRecentChats(10, { account: 'lister@example.com', includeProjects: true });
  assert.deepEqual(chats.map((c) => c.id), ['proj-new', 'main-old']);
  assert.equal(chats[0].project_name, 'DoDAF');
  assert.deepEqual(f.received.map((m) => m.action), ['list_recent_chats', 'list_project_chats']);
});

test('threadIdFromInput accepts ids and chatgpt.com links, rejects junk', () => {
  assert.equal(mod.threadIdFromInput('https://chatgpt.com/c/6ab4445d-04e0-83e9-ad97-78db2e45b9b7'), '6ab4445d-04e0-83e9-ad97-78db2e45b9b7');
  assert.equal(mod.threadIdFromInput('https://chatgpt.com/g/g-p-abc-dodaf/c/6ab4445d-04e0-83e9-ad97-78db2e45b9b7'), '6ab4445d-04e0-83e9-ad97-78db2e45b9b7');
  assert.equal(mod.threadIdFromInput(' 6ab4445d-04e0-83e9-ad97-78db2e45b9b7 '), '6ab4445d-04e0-83e9-ad97-78db2e45b9b7');
  assert.throws(() => mod.threadIdFromInput('not a link'), /not a ChatGPT conversation id/);
});
