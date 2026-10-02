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

test('an observed 429 routes the next unpinned new ask to the account with the earlier projected start', async () => {
  const accountA = 'route-a@example.com';
  const accountB = 'route-b@example.com';
  const entryA = mod.getPacerEntry(accountA);
  const entryB = mod.getPacerEntry(accountB);
  const savedA = { minMs: entryA.pacer.minMs, maxMs: entryA.pacer.maxMs, spacingMs: entryA.pacer.spacingMs,
    rateLimited: entryA.pacer.rateLimited, successes: entryA.pacer.successes, lastRequestAt: entryA.lastRequestAt };
  const savedB = { minMs: entryB.pacer.minMs, maxMs: entryB.pacer.maxMs, spacingMs: entryB.pacer.spacingMs,
    rateLimited: entryB.pacer.rateLimited, successes: entryB.pacer.successes, lastRequestAt: entryB.lastRequestAt };
  entryA.pacer.minMs = entryB.pacer.minMs = 0;
  entryA.pacer.maxMs = entryB.pacer.maxMs = 120000;
  entryA.pacer.spacingMs = entryB.pacer.spacingMs = 50;
  entryA.pacer.rateLimited = entryB.pacer.rateLimited = 0;
  entryA.pacer.successes = entryB.pacer.successes = 0;
  entryA.lastRequestAt = entryB.lastRequestAt = -Infinity;

  let pollsA = 0;
  const handler = (threadId, replyText, rateLimitFirstPoll = false) => async (msg) => {
    if (msg.action === 'get_tab') return { busy: false, thread_id: null };
    if (msg.action === 'navigate_home') return { navigated: true };
    if (msg.action === 'send_prompt') {
      return { thread_id: threadId, dom_before: 0, messages_before: 0 };
    }
    if (msg.action === 'get_reply') {
      if (rateLimitFirstPoll && pollsA++ === 0) {
        return { done: true, reply: replyText, thread_id: threadId, visible_error: 'too_many_requests', api_checked: true, api_status: 429 };
      }
      return { done: true, reply: replyText, thread_id: threadId, api_checked: false };
    }
    throw new Error(`unexpected ${msg.action}`);
  };
  const handlerA = handler('route-a-thread', 'A reply', true);
  const handlerB = handler('route-b-thread', 'B reply');
  const a = await tab('route-a-agent', accountA, { agent: true, handlers: {
    get_tab: handlerA,
    navigate_home: handlerA,
    send_prompt: handlerA,
    get_reply: handlerA,
  } });
  const b = await tab('route-b-agent', accountB, { agent: true, handlers: {
    get_tab: handlerB,
    navigate_home: handlerB,
    send_prompt: handlerB,
    get_reply: handlerB,
  } });
  try {
    const first = await mod.askChatgpt({ text: 'trigger the synthetic 429 on A', account: accountA, timeout_seconds: 5, pollMs: 2, confirmGraceMs: 100 });
    assert.equal(first.account, accountA);
    assert.equal(entryA.pacer.rateLimited, 1);
    assert.ok(entryA.pacer.spacingMs > entryB.pacer.spacingMs);

    // Align the last request times so the next choice is driven by the learned
    // per-account cooldown, not by one account simply being idle longer.
    entryA.lastRequestAt = entryB.lastRequestAt = performance.now() - 10;
    const next = await mod.askChatgpt({ text: 'route this new ask automatically', timeout_seconds: 5, pollMs: 2, confirmGraceMs: 100 });
    assert.equal(next.account, accountB);
    assert.equal(next.reply, 'B reply');
    assert.equal(a.received.filter((m) => m.action === 'send_prompt').length, 1);
    assert.equal(b.received.filter((m) => m.action === 'send_prompt').length, 1);

    const timing = fs.readFileSync(mod.REQUEST_TIMING_PATH, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(timing.some((event) => event.event_type === 'broker_action' && event.account === accountA && event.rate_limited === true));
    const route = timing.find((event) => event.event_type === 'account_route');
    assert.ok(route, 'the scheduler decision was not recorded');
    assert.equal(route.selection_rule, 'earliest_projected_start_with_idle_agent_tab');
    assert.equal(route.selected_account, accountB);
    const projectedA = route.candidates.find((candidate) => candidate.account === accountA);
    const projectedB = route.candidates.find((candidate) => candidate.account === accountB);
    assert.ok(projectedA.projected_start_in_ms > projectedB.projected_start_in_ms);

    const bridgeEvents = fs.readFileSync(mod.BRIDGE_OBSERVATIONS_PATH, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const outcome = bridgeEvents.find((event) => event.route_id === route.route_id);
    assert.equal(outcome.account, accountB);
    assert.equal(outcome.outcome, 'success');

    // Equalize the accounts and launch two new asks in the same turn. The
    // first assignment must reserve its account before tab probing so the
    // second sees that queued work and spreads across the other account.
    entryA.pacer.spacingMs = entryB.pacer.spacingMs = 50;
    entryA.lastRequestAt = entryB.lastRequestAt = -Infinity;
    const parallel = await Promise.all([
      mod.askChatgpt({ text: 'parallel unpinned ask one', timeout_seconds: 5, pollMs: 2, confirmGraceMs: 100 }),
      mod.askChatgpt({ text: 'parallel unpinned ask two', timeout_seconds: 5, pollMs: 2, confirmGraceMs: 100 }),
    ]);
    assert.deepEqual(new Set(parallel.map((result) => result.account)), new Set([accountA, accountB]));
  } finally {
    Object.assign(entryA.pacer, { minMs: savedA.minMs, maxMs: savedA.maxMs, spacingMs: savedA.spacingMs,
      rateLimited: savedA.rateLimited, successes: savedA.successes });
    entryA.lastRequestAt = savedA.lastRequestAt;
    Object.assign(entryB.pacer, { minMs: savedB.minMs, maxMs: savedB.maxMs, spacingMs: savedB.spacingMs,
      rateLimited: savedB.rateLimited, successes: savedB.successes });
    entryB.lastRequestAt = savedB.lastRequestAt;
    a.ws.close();
    b.ws.close();
  }
});

test('routing counts a pinned active ask and an unclaimed automatic assignment separately', async () => {
  const accountA = 'mixed-a@example.com';
  const accountB = 'mixed-b@example.com';
  const entryA = mod.getPacerEntry(accountA);
  const entryB = mod.getPacerEntry(accountB);
  const savedA = { minMs: entryA.pacer.minMs, maxMs: entryA.pacer.maxMs, spacingMs: entryA.pacer.spacingMs,
    rateLimited: entryA.pacer.rateLimited, successes: entryA.pacer.successes, lastRequestAt: entryA.lastRequestAt };
  const savedB = { minMs: entryB.pacer.minMs, maxMs: entryB.pacer.maxMs, spacingMs: entryB.pacer.spacingMs,
    rateLimited: entryB.pacer.rateLimited, successes: entryB.pacer.successes, lastRequestAt: entryB.lastRequestAt };
  entryA.pacer.minMs = entryB.pacer.minMs = 0;
  entryA.pacer.maxMs = entryB.pacer.maxMs = 120000;
  entryA.pacer.spacingMs = 40;
  entryB.pacer.spacingMs = 100;
  entryA.pacer.rateLimited = entryB.pacer.rateLimited = 0;
  entryA.pacer.successes = entryB.pacer.successes = 0;
  entryA.lastRequestAt = entryB.lastRequestAt = -Infinity;

  let notePinnedPoll;
  let releaseAProbe;
  let noteAProbe;
  let noteBProbe;
  let pinnedFinished = false;
  const pinnedPollStarted = new Promise((resolve) => { notePinnedPoll = resolve; });
  const aProbeGate = new Promise((resolve) => { releaseAProbe = resolve; });
  const aProbeStarted = new Promise((resolve) => { noteAProbe = resolve; });
  const bProbeStarted = new Promise((resolve) => { noteBProbe = resolve; });
  let pinnedAsk;
  let queuedAutoAsk;
  let nextAutoAsk;

  const pinned = await tab('mix-a-pinned', accountA, { agent: true, handlers: {
    get_tab: () => ({ busy: false, thread_id: null }),
    navigate_home: () => ({ navigated: true }),
    send_prompt: () => ({ thread_id: 'mixed-pinned-thread', dom_before: 0, messages_before: 0 }),
    get_reply: () => {
      notePinnedPoll();
      return pinnedFinished
        ? { done: true, reply: 'pinned reply', thread_id: 'mixed-pinned-thread', source: 'api', end_turn: true, api_checked: false }
        : { done: false, generating: false, thread_id: 'mixed-pinned-thread', source: 'api_waiting', api_checked: false };
    },
  } });
  const aIdle = await tab('mix-a-idle', accountA, { agent: true, handlers: {
    get_tab: async () => { noteAProbe(); await aProbeGate; return { busy: false, thread_id: null }; },
    navigate_home: () => ({ navigated: true }),
    send_prompt: () => ({ thread_id: 'mixed-auto-a-thread', dom_before: 0, messages_before: 0 }),
    get_reply: () => ({ done: true, reply: 'A reply', thread_id: 'mixed-auto-a-thread', source: 'api', end_turn: true, api_checked: false }),
  } });
  const bIdle = await tab('mix-b-idle', accountB, { agent: true, handlers: {
    get_tab: () => { noteBProbe(); return { busy: false, thread_id: null }; },
    navigate_home: () => ({ navigated: true }),
    send_prompt: () => ({ thread_id: 'mixed-auto-b-thread', dom_before: 0, messages_before: 0 }),
    get_reply: () => ({ done: true, reply: 'B reply', thread_id: 'mixed-auto-b-thread', source: 'api', end_turn: true, api_checked: false }),
  } });

  try {
    pinnedAsk = mod.askChatgpt({ text: 'keep pinned ask active', account: accountA, timeout_seconds: 5, pollMs: 5 });
    await pinnedPollStarted;
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The pinned ask has an active tab, but its send gap has elapsed. B is
    // projected slightly later, so the first automatic assignment reserves A.
    entryA.pacer.spacingMs = 40;
    entryB.pacer.spacingMs = 100;
    entryB.lastRequestAt = performance.now() - 25;

    queuedAutoAsk = mod.askChatgpt({ text: 'reserve A while its tab is being checked', timeout_seconds: 5, pollMs: 5 });
    await aProbeStarted;
    nextAutoAsk = mod.askChatgpt({ text: 'account for both asks ahead', timeout_seconds: 5, pollMs: 5 });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the second automatic ask did not probe account B')), 1000);
      bProbeStarted.then(() => { clearTimeout(timer); resolve(); });
    });

    const routedToB = await nextAutoAsk;
    assert.equal(routedToB.account, accountB);
    releaseAProbe();
    const routedToA = await queuedAutoAsk;
    assert.equal(routedToA.account, accountA);
    pinnedFinished = true;
    assert.equal((await pinnedAsk).reply, 'pinned reply');
  } finally {
    releaseAProbe();
    pinnedFinished = true;
    await Promise.allSettled([pinnedAsk, queuedAutoAsk, nextAutoAsk].filter(Boolean));
    Object.assign(entryA.pacer, { minMs: savedA.minMs, maxMs: savedA.maxMs, spacingMs: savedA.spacingMs,
      rateLimited: savedA.rateLimited, successes: savedA.successes });
    entryA.lastRequestAt = savedA.lastRequestAt;
    Object.assign(entryB.pacer, { minMs: savedB.minMs, maxMs: savedB.maxMs, spacingMs: savedB.spacingMs,
      rateLimited: savedB.rateLimited, successes: savedB.successes });
    entryB.lastRequestAt = savedB.lastRequestAt;
    pinned.ws.close(); aIdle.ws.close(); bIdle.ws.close();
  }
});

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

test('bulk archive refuses ambiguous accounts before dispatch and targets only an explicit account', async () => {
  const accountA = 'archive-a@example.com';
  const accountB = 'archive-b@example.com';
  const a = await tab('archive-a-tab', accountA, { handlers: { archive_all_chats: () => ({ started: true }) } });
  const b = await tab('archive-b-tab', accountB, { handlers: { archive_all_chats: () => ({ started: true }) } });

  await assert.rejects(
    () => mod.dispatchToExtension({ action: 'archive_all_chats', known: {} }, 1000, { single: true }),
    /Bulk archive requires an explicit account/,
  );
  assert.equal(a.received.length, 0);
  assert.equal(b.received.length, 0);

  await mod.dispatchToExtension({ action: 'archive_all_chats', known: {} }, 1000, { single: true, account: accountA });
  assert.equal(a.received.length, 1);
  assert.equal(a.received[0].action, 'archive_all_chats');
  assert.equal(b.received.length, 0);
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

test('a thread_snapshot is stamped with the account of the tab that pushed it', async () => {
  const email = 'stamp-a@example.com';
  const { ws } = await tab('stamp-tab', email);
  const threadId = 'stamp-thread-1';
  const acked = new Promise((resolve) => ws.on('message', (buf) => { const m = JSON.parse(buf.toString()); if (m.type === 'snapshot_ack') resolve(m); }));
  ws.send(JSON.stringify({ type: 'thread_snapshot', snapshot: { thread_id: threadId, title: 'Stamped', capture_source: 'api',
    messages: [{ message_id: 'm1', role: 'user', text: 'hi' }] } }));
  await acked;
  const dir = process.env.ARCHIVE_DIR;
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'metadata', 'catalog.json'), 'utf8'));
  assert.equal(catalog.threads[threadId].account, email);
  const rawJson = JSON.parse(fs.readFileSync(path.join(dir, 'raw', 'chats', `${threadId}.json`), 'utf8'));
  assert.equal(rawJson.capture_account, email);
});
