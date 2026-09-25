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

test('a rate-limit signal on one account widens only that account\'s pacer, and the persisted state keys them independently', async () => {
  const a = await tab('a1111111-a', 'pacer-a@example.com', { agent: true, handlers: {
    get_tab: () => ({ busy: false, thread_id: null }),
    send_prompt: () => ({ thread_id: 'thread-a', dom_before: 0, messages_before: 0 }),
    // api_checked + api_status 429 is the real signal a live rate-limited
    // reply carries (see tests/server.test.js's own rate-limit test).
    get_reply: () => ({ done: true, reply: 'a reply', thread_id: 'thread-a', visible_error: 'too_many_requests', api_checked: true, api_status: 429 }),
  } });
  const b = await tab('b2222222-b', 'pacer-b@example.com', { agent: true, handlers: {
    get_tab: () => ({ busy: false, thread_id: null }),
    send_prompt: () => ({ thread_id: 'thread-b', dom_before: 0, messages_before: 0 }),
    get_reply: () => ({ done: true, reply: 'b reply', thread_id: 'thread-b', api_checked: true }),
  } });

  // Fresh per-account entries start at the same floor as the shared
  // agentPacer did before before() zeroed it; zero these too so the test
  // exercises the rate-limit reaction itself, not real multi-second waits.
  mod.getPacerEntry('pacer-a@example.com').pacer.minMs = 0;
  mod.getPacerEntry('pacer-a@example.com').pacer.spacingMs = 0;
  mod.getPacerEntry('pacer-b@example.com').pacer.minMs = 0;
  mod.getPacerEntry('pacer-b@example.com').pacer.spacingMs = 0;

  await mod.askChatgpt({ text: 'trips the limit on A only', account: 'pacer-a@example.com', timeout_seconds: 10, pollMs: 5 });
  await mod.askChatgpt({ text: 'clean reply on B', account: 'pacer-b@example.com', timeout_seconds: 10, pollMs: 5 });

  const raw = JSON.parse(fs.readFileSync(path.join(process.env.ARCHIVE_DIR, 'observations', 'agent-pacer-state.json'), 'utf8'));
  assert.ok('pacer-a@example.com' in raw, `expected a per-account entry for pacer-a@example.com, got keys: ${Object.keys(raw)}`);
  assert.ok('pacer-b@example.com' in raw, `expected a per-account entry for pacer-b@example.com, got keys: ${Object.keys(raw)}`);
  assert.ok(raw['pacer-a@example.com'].rateLimited > 0, 'expected account A\'s own pacer to record the rate-limit signal');
  assert.equal(raw['pacer-b@example.com'].rateLimited, 0, 'account B never saw a rate-limit signal, so its pacer must not have widened');
  assert.ok(raw['pacer-a@example.com'].spacingMs > raw['pacer-b@example.com'].spacingMs, 'A\'s gap should be wider than B\'s after only A was rate-limited');
  assert.ok(a.received.some((m) => m.action === 'get_reply'));
  assert.ok(b.received.some((m) => m.action === 'get_reply'));
});

test('threadIdFromInput accepts ids and chatgpt.com links, rejects junk', () => {
  assert.equal(mod.threadIdFromInput('https://chatgpt.com/c/6ab4445d-04e0-83e9-ad97-78db2e45b9b7'), '6ab4445d-04e0-83e9-ad97-78db2e45b9b7');
  assert.equal(mod.threadIdFromInput('https://chatgpt.com/g/g-p-abc-dodaf/c/6ab4445d-04e0-83e9-ad97-78db2e45b9b7'), '6ab4445d-04e0-83e9-ad97-78db2e45b9b7');
  assert.equal(mod.threadIdFromInput(' 6ab4445d-04e0-83e9-ad97-78db2e45b9b7 '), '6ab4445d-04e0-83e9-ad97-78db2e45b9b7');
  assert.throws(() => mod.threadIdFromInput('not a link'), /not a ChatGPT conversation id/);
});

test('health reports the extension version on disk, which the extension compares to reload itself', async () => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  const body = await res.json();
  const onDisk = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')).version;
  assert.equal(body.extension_version, onDisk);
});

test('a tab reconnecting with the same token closes its superseded socket (4001) so old code cannot act twice', async () => {
  const oldCode = await tab('99999999-dup', 'dup@example.com', { handlers: { read_conversation: () => { throw new Error('old code must not be used'); } } });
  const closed = new Promise((resolve) => oldCode.ws.on('close', (code) => resolve(code)));
  const newCode = await tab('99999999-dup', 'dup@example.com', { handlers: { read_conversation: (m) => ({ thread_id: m.thread_id, title: 'new', messages: [], images: [], account: { email: 'dup@example.com' } }) } });
  assert.equal(await closed, 4001);
  const r = await mod.readChatgptChat({ thread: 'x-1', account: 'dup@example.com' });
  assert.equal(r.title, 'new');
  assert.equal(oldCode.received.length, 0);
  assert.equal(newCode.received.length, 1);
  assert.equal(mod.listConnections().filter((c) => c.tab === '99999999').length, 1);
});
