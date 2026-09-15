import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeConversationTree, fetchConversationTree, linearizeMapping, captureViaApi, listConversationsPage, listAllConversations, getConversationProjectId, parseRemoteTime, selectChangedConversations } from '../extension/lib/api-capture.js';

test('parseRemoteTime accepts epoch seconds, epoch ms, numeric strings and ISO strings', () => {
  assert.equal(parseRemoteTime(1757900000.5), 1757900000500);
  assert.equal(parseRemoteTime(1757900000500), 1757900000500);
  assert.equal(parseRemoteTime('1757900000'), 1757900000000);
  assert.equal(parseRemoteTime('2026-09-15T01:00:00.000Z'), Date.parse('2026-09-15T01:00:00.000Z'));
  assert.equal(parseRemoteTime('garbage'), null);
  assert.equal(parseRemoteTime(undefined), null);
});

test('selectChangedConversations keeps new and updated threads and skips unchanged ones', () => {
  const known = {
    unchanged: '2026-09-14T20:00:00.000Z',
    updated: '2026-09-14T20:00:00.000Z',
    'bad-time': '2026-09-14T20:00:00.000Z',
  };
  const items = [
    { id: 'unchanged', update_time: '2026-09-14T19:59:00.000Z' },
    { id: 'updated', update_time: Date.parse('2026-09-14T20:05:00.000Z') / 1000 },
    { id: 'brand-new', update_time: '2026-09-01T00:00:00.000Z' },
    { id: 'bad-time', update_time: 'not a time' },
  ];
  assert.deepEqual(selectChangedConversations(items, known).map((c) => c.id), ['updated', 'brand-new', 'bad-time']);
  assert.deepEqual(selectChangedConversations(items).map((c) => c.id), ['unchanged', 'updated', 'brand-new', 'bad-time']);
});

function userMsg(id, text, createTime) {
  return { id, message: { id, author: { role: 'user' }, content: { content_type: 'text', parts: [text] }, create_time: createTime }, parent: null, children: [] };
}
function assistantMsg(id, text, createTime) {
  return { id, message: { id, author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] }, create_time: createTime, metadata: { model_slug: 'gpt-5' } }, parent: null, children: [] };
}

test('looksLikeConversationTree validates the expected shape', () => {
  assert.equal(looksLikeConversationTree({ mapping: {}, current_node: 'x' }), true);
  assert.equal(looksLikeConversationTree({ mapping: {}, current_node: null }), false);
  assert.equal(looksLikeConversationTree({ mapping: null, current_node: 'x' }), false);
  assert.equal(looksLikeConversationTree(null), false);
  assert.equal(looksLikeConversationTree('not an object'), false);
});

test('linearizeMapping walks only the current_node parent chain in chronological order', () => {
  // root -> u1 -> a1 -> u2(branch A, NOT current) and u2b(branch B, current)
  const mapping = {
    root: { id: 'root', message: null, parent: null },
    u1: { id: 'u1', message: userMsg('u1', 'first message', 1).message, parent: 'root' },
    a1: { id: 'a1', message: assistantMsg('a1', 'first reply', 2).message, parent: 'u1' },
    u2: { id: 'u2', message: userMsg('u2', 'branch A follow-up', 3).message, parent: 'a1' },
    u2b: { id: 'u2b', message: userMsg('u2b', 'branch B follow-up (current)', 4).message, parent: 'a1' },
    a2b: { id: 'a2b', message: assistantMsg('a2b', 'final reply', 5).message, parent: 'u2b' },
  };
  const data = { mapping, current_node: 'a2b', title: 'Test conversation' };
  const messages = linearizeMapping(data);
  assert.deepEqual(
    messages.map((m) => m.message_id),
    ['u1', 'a1', 'u2b', 'a2b']
  );
  assert.equal(messages.some((m) => m.message_id === 'u2'), false, 'off-current branch must not be included');
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(messages[0].text, 'first message');
  assert.equal(messages[3].model, 'gpt-5');
  assert.equal(messages[0].created_at, new Date(1000).toISOString());
});

test('linearizeMapping skips system messages and the message-less root node', () => {
  const mapping = {
    root: { id: 'root', message: null, parent: null },
    sys: { id: 'sys', message: { author: { role: 'system' }, content: { parts: ['hidden system prompt'] } }, parent: 'root' },
    u1: { id: 'u1', message: userMsg('u1', 'hello', 1).message, parent: 'sys' },
  };
  const messages = linearizeMapping({ mapping, current_node: 'u1' });
  assert.deepEqual(
    messages.map((m) => m.message_id),
    ['u1']
  );
});

test('linearizeMapping guards against cycles instead of looping forever', () => {
  const mapping = {
    a: { id: 'a', message: userMsg('a', 'a', 1).message, parent: 'b' },
    b: { id: 'b', message: userMsg('b', 'b', 2).message, parent: 'a' }, // cycle
  };
  const messages = linearizeMapping({ mapping, current_node: 'a' });
  assert.ok(messages.length <= 2);
});

test('linearizeMapping throws when current_node is missing/unresolvable', () => {
  assert.throws(() => linearizeMapping({ mapping: {}, current_node: 'missing' }));
  assert.throws(() => linearizeMapping({ mapping: {} }));
});

test('fetchConversationTree throws on non-OK HTTP status and lets the caller fall back', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(() => fetchConversationTree('t1', { fetchImpl }), /HTTP 404/);
});

test('fetchConversationTree throws when the response does not look like a conversation tree', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) });
  await assert.rejects(() => fetchConversationTree('t1', { fetchImpl }), /schema may have changed/);
});

test('fetchConversationTree attaches the session Authorization bearer token to the conversation request', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts?.headers || {} });
    if (String(url).includes('/api/auth/session')) {
      return { ok: true, json: async () => ({ accessToken: 'test-jwt-123' }) };
    }
    return { ok: true, status: 200, json: async () => ({ mapping: {}, current_node: 'x' }) };
  };
  await fetchConversationTree('t1', { fetchImpl });
  const convCall = calls.find((c) => String(c.url).includes('/backend-api/conversation/t1'));
  assert.equal(convCall.headers.Authorization, 'Bearer test-jwt-123');
});

test('fetchConversationTree still attempts the conversation request (without a bearer token) when the session endpoint is unavailable', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts?.headers || {} });
    if (String(url).includes('/api/auth/session')) throw new Error('network error');
    return { ok: true, status: 200, json: async () => ({ mapping: {}, current_node: 'x' }) };
  };
  await fetchConversationTree('t1', { fetchImpl });
  const convCall = calls.find((c) => String(c.url).includes('/backend-api/conversation/t1'));
  assert.equal(convCall.headers.Authorization, undefined);
});

test('captureViaApi returns title + linearized messages end-to-end', async () => {
  const mapping = {
    root: { id: 'root', message: null, parent: null },
    u1: { id: 'u1', message: userMsg('u1', 'hi', 1).message, parent: 'root' },
    a1: { id: 'a1', message: assistantMsg('a1', 'hello', 2).message, parent: 'u1' },
  };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ mapping, current_node: 'a1', title: 'Greeting thread' }) });
  const result = await captureViaApi('t1', { fetchImpl });
  assert.equal(result.title, 'Greeting thread');
  assert.equal(result.messages.length, 2);
});

test('listConversationsPage rejects a response that does not look like a list', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ notItems: true }) });
  await assert.rejects(() => listConversationsPage({ fetchImpl, accessToken: null }), /schema may have changed/);
});

test('listAllConversations pages until it has collected everything, reusing one access token', async () => {
  const tokenFetches = [];
  const conversationFetches = [];
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/auth/session')) {
      tokenFetches.push(url);
      return { ok: true, json: async () => ({ accessToken: 'shared-token' }) };
    }
    conversationFetches.push(url);
    const offset = Number(new URL(url, 'https://chatgpt.com').searchParams.get('offset'));
    const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    return { ok: true, json: async () => ({ items: all.slice(offset, offset + 2), total: all.length, offset, limit: 2 }) };
  };
  const results = await listAllConversations({ fetchImpl, pageSize: 2 });
  assert.deepEqual(results.map((c) => c.id), ['a', 'b', 'c']);
  assert.equal(tokenFetches.length, 1); // fetched once, reused across pages
  assert.equal(conversationFetches.length, 2); // two pages of size 2 to cover 3 items
});

test('listAllConversations stops when a page returns only already-seen ids, even if full-sized (regression: order=updated pagination returning stale non-empty pages past the real end, observed live as an unbounded ~10x blowup)', async () => {
  let pageCount = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/auth/session')) return { ok: true, json: async () => ({ accessToken: 't' }) };
    pageCount++;
    if (pageCount <= 2) {
      // Two genuinely new full pages of 2.
      const ids = pageCount === 1 ? ['a', 'b'] : ['c', 'd'];
      return { ok: true, json: async () => ({ items: ids.map((id) => ({ id })), total: 999, limit: 2 }) };
    }
    // From here on, the server keeps returning a full, non-empty page — but
    // every id in it has already been seen. This must not be mistaken for progress.
    return { ok: true, json: async () => ({ items: [{ id: 'a' }, { id: 'b' }], total: 999, limit: 2 }) };
  };
  const results = await listAllConversations({ fetchImpl, pageSize: 2 });
  assert.deepEqual(results.map((c) => c.id).sort(), ['a', 'b', 'c', 'd']);
  assert.equal(pageCount, 3); // 2 productive pages + 1 all-duplicates page that triggers the stop
});

test('getConversationProjectId reads conversation_template_id (falling back to gizmo_id) as the project membership signal', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/auth/session')) return { ok: true, json: async () => ({ accessToken: 't' }) };
    return { ok: true, json: async () => ({ conversation_template_id: 'g-p-abc123', gizmo_id: 'g-p-abc123' }) };
  };
  const id = await getConversationProjectId('t1', { fetchImpl });
  assert.equal(id, 'g-p-abc123');
});

test('getConversationProjectId returns null when the conversation has no project (both fields absent)', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/auth/session')) return { ok: true, json: async () => ({ accessToken: 't' }) };
    return { ok: true, json: async () => ({ conversation_template_id: null, gizmo_id: null }) };
  };
  const id = await getConversationProjectId('t1', { fetchImpl });
  assert.equal(id, null);
});

test('getConversationProjectId throws on a non-OK response, distinguishable from "no project"', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/auth/session')) return { ok: true, json: async () => ({ accessToken: 't' }) };
    return { ok: false, status: 404 };
  };
  await assert.rejects(() => getConversationProjectId('t1', { fetchImpl }), /HTTP 404/);
});
