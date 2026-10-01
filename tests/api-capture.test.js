import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeConversationTree, fetchConversationTree, linearizeMapping, captureViaApi, listConversationsPage, listAllConversations, getConversationProjectId, parseRemoteTime, selectChangedConversations, captureWithRecovery, AdaptivePacer, parseRetryAfter, replyFromTree, resolveFileDownloadUrl, nextReplyCheckGapMs, fatalArchiveErrorDetails } from '../extension/lib/api-capture.js';

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

// Mirrors ChatGPT's actual shape for a reply that includes a generated image:
// content_type "multimodal_text", with the image as an object part alongside
// (or instead of) any caption text.
function assistantImageMsg(id, text, assetPointer, createTime) {
  const parts = [];
  if (text) parts.push(text);
  parts.push({ content_type: 'image_asset_pointer', asset_pointer: assetPointer, width: 1024, height: 1024 });
  return {
    id,
    message: {
      id,
      author: { role: 'assistant' },
      content: { content_type: 'multimodal_text', parts },
      create_time: createTime,
      metadata: { model_slug: 'gpt-image-1' },
    },
    parent: null,
    children: [],
  };
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

test('archive fatal-error metadata preserves the list endpoint status and Retry-After structurally', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '12' : null },
  });
  await assert.rejects(() => listConversationsPage({ fetchImpl, accessToken: null }), (error) => {
    assert.deepEqual(fatalArchiveErrorDetails(error), {
      fatal_error: 'conversations list fetch failed: HTTP 429',
      fatal_error_status: 429,
      fatal_error_retry_after_ms: 12000,
    });
    return true;
  });
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

const httpErr = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
const noSleep = async () => {};

test('parseRetryAfter reads delay-seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('7'), 7000);
  assert.equal(parseRetryAfter('Tue, 15 Sep 2026 03:00:10 GMT', Date.parse('Tue, 15 Sep 2026 03:00:00 GMT')), 10000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
});

test('fetchConversationTree attaches status and Retry-After to a 429', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '12' : null) }, json: async () => ({}) });
  await assert.rejects(fetchConversationTree('t1', { fetchImpl, accessToken: 'x' }), (err) => err.status === 429 && err.retryAfterMs === 12000);
});

test('AdaptivePacer shortens on success, doubles on 429, and stays in bounds', () => {
  const p = new AdaptivePacer({ initialMs: 1000, minMs: 500, maxMs: 5000 });
  p.onSuccess();
  assert.equal(p.spacingMs, 900);
  for (let i = 0; i < 20; i++) p.onSuccess();
  assert.equal(p.spacingMs, 500);
  assert.equal(p.onRateLimit(), 1000);
  assert.equal(p.onRateLimit(), 2000);
  assert.equal(p.onRateLimit(30000), 5000, 'Retry-After is honoured but capped at maxMs');
  assert.equal(p.onRateLimit(), 5000);
  assert.deepEqual(p.stats(), { spacing_ms: 5000, rate_limited: 4, successes: 21 });
});

test('AdaptivePacer converges between the throttling threshold and half of it', () => {
  // Simulated server: throttles any request sent sooner than 1500ms after the previous one.
  const p = new AdaptivePacer({ initialMs: 10000, minMs: 100, maxMs: 60000 });
  const tail = [];
  for (let i = 0; i < 400; i++) {
    if (p.spacingMs < 1500) p.onRateLimit(); else p.onSuccess();
    if (i >= 300) tail.push(p.spacingMs);
  }
  assert.ok(Math.min(...tail) >= 750 && Math.max(...tail) <= 3000, `settled range ${Math.min(...tail)}-${Math.max(...tail)}`);
});

test('captureWithRecovery refreshes an expired token once and retries', async () => {
  const tokenRef = { token: 'old' };
  const seen = [];
  const pacer = new AdaptivePacer();
  const result = await captureWithRecovery('t1', {
    tokenRef, pacer,
    capture: async (_id, { accessToken }) => { seen.push(accessToken); if (accessToken === 'old') throw httpErr(401); return { title: 'ok', messages: [] }; },
    refreshToken: async () => 'new',
    sleep: noSleep,
  });
  assert.equal(result.title, 'ok');
  assert.deepEqual(seen, ['old', 'new']);
  assert.equal(tokenRef.token, 'new');
});

test('captureWithRecovery does not loop on a token that stays rejected', async () => {
  await assert.rejects(
    captureWithRecovery('t1', { tokenRef: { token: 'x' }, pacer: new AdaptivePacer(), capture: async () => { throw httpErr(401); }, refreshToken: async () => 'y', sleep: noSleep }),
    (err) => err.status === 401 && !err.abortRun,
  );
});

test('captureWithRecovery waits the pacer delay on 429, then succeeds and speeds back up', async () => {
  const waits = [];
  let calls = 0;
  const pacer = new AdaptivePacer({ initialMs: 1000, minMs: 100 });
  const ok = await captureWithRecovery('t1', {
    tokenRef: { token: 'x' }, pacer,
    capture: async () => { calls++; if (calls < 3) throw httpErr(429, calls === 2 ? { retryAfterMs: 9000 } : {}); return { title: 'late', messages: [] }; },
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(ok.title, 'late');
  assert.deepEqual(waits, [2000, 9000]);
  assert.equal(pacer.spacingMs, 3600, 'doubled twice to 4000, then one success shortens it');
});

test('captureWithRecovery aborts the run when one conversation stays throttled', async () => {
  await assert.rejects(
    captureWithRecovery('t1', { tokenRef: { token: 'x' }, pacer: new AdaptivePacer(), capture: async () => { throw httpErr(429, { retryAfterMs: 45000 }); }, sleep: noSleep, maxRateLimitRetries: 3 }),
    (err) => err.abortRun === true && err.status === 429 && err.retryAfterMs === 45000 && /4 times in a row/.test(err.message),
  );
});

test('captureWithRecovery passes other errors straight through', async () => {
  await assert.rejects(
    captureWithRecovery('t1', { tokenRef: { token: 'x' }, pacer: new AdaptivePacer(), capture: async () => { throw httpErr(404); }, sleep: async () => { throw new Error('should not wait'); } }),
    (err) => err.status === 404 && !err.abortRun,
  );
});

function treeOf(nodes, current) {
  const mapping = { root: { id: 'root', message: null, parent: null } };
  let parent = 'root';
  for (const n of nodes) { mapping[n.id] = { id: n.id, message: n.message, parent }; parent = n.id; }
  return { mapping, current_node: current ?? parent };
}

test('replyFromTree waits while the assistant message is still streaming, then returns it', () => {
  const u1 = userMsg('u1', 'earlier question', 1).message;
  const a1 = assistantMsg('a1', 'earlier answer', 2).message;
  const u2 = userMsg('u2', 'our new question', 3).message;
  const streaming = { ...assistantMsg('a2', 'partial', 4).message, status: 'in_progress' };
  let r = replyFromTree(treeOf([{ id: 'u1', message: u1 }, { id: 'a1', message: a1 }, { id: 'u2', message: u2 }, { id: 'a2', message: streaming }]), 2);
  assert.equal(r.done, false);
  assert.equal(r.status, 'in_progress');
  const finished = { ...assistantMsg('a2', 'the full answer', 4).message, status: 'finished_successfully' };
  r = replyFromTree(treeOf([{ id: 'u1', message: u1 }, { id: 'a1', message: a1 }, { id: 'u2', message: u2 }, { id: 'a2', message: finished }]), 2);
  assert.equal(r.done, true);
  assert.equal(r.reply, 'the full answer');
});

test('replyFromTree does not return the previous answer when our message has no reply yet', () => {
  const u1 = userMsg('u1', 'earlier question', 1).message;
  const a1 = { ...assistantMsg('a1', 'earlier answer', 2).message, status: 'finished_successfully' };
  // before sending there were 2 messages; the tree has not yet grown past them
  const r = replyFromTree(treeOf([{ id: 'u1', message: u1 }, { id: 'a1', message: a1 }]), 2);
  assert.equal(r.done, false);
  // our message landed but the current node is still our user message
  const u2 = userMsg('u2', 'our new question', 3).message;
  const r2 = replyFromTree(treeOf([{ id: 'u1', message: u1 }, { id: 'a1', message: a1 }, { id: 'u2', message: u2 }]), 2);
  assert.equal(r2.done, false);
  assert.equal(r2.role, 'user');
});

test('replyFromTree surfaces a generated image asset pointer alongside the text reply', () => {
  const u1 = userMsg('u1', 'draw a legion banner', 1).message;
  const a1 = { ...assistantImageMsg('a1', 'Here you go:', 'file-service://file-ABC123', 2).message, status: 'finished_successfully' };
  const r = replyFromTree(treeOf([{ id: 'u1', message: u1 }, { id: 'a1', message: a1 }]), 1);
  assert.equal(r.done, true);
  assert.equal(r.reply, 'Here you go:');
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0].asset_pointer, 'file-service://file-ABC123');
  assert.equal(r.images[0].content_type, 'image_asset_pointer');
});

test('replyFromTree omits images entirely when the reply has no image parts', () => {
  const a1 = { ...assistantMsg('a1', 'just text', 1).message, status: 'finished_successfully' };
  const r = replyFromTree(treeOf([{ id: 'a1', message: a1 }]), 0);
  assert.equal(r.done, true);
  assert.equal(r.images, undefined);
});

test('replyFromTree collects images from every new assistant turn, not just the last', () => {
  const a1 = { ...assistantImageMsg('a1', 'first', 'file-service://file-ONE', 1).message, status: 'finished_successfully' };
  const u2 = userMsg('u2', 'and another', 2).message;
  const a2 = { ...assistantImageMsg('a2', 'second', 'file-service://file-TWO', 3).message, status: 'finished_successfully' };
  const r = replyFromTree(treeOf([{ id: 'a1', message: a1 }, { id: 'u2', message: u2 }, { id: 'a2', message: a2 }]), 0);
  assert.deepEqual(r.images.map((i) => i.asset_pointer), ['file-service://file-ONE', 'file-service://file-TWO']);
});

test('resolveFileDownloadUrl exchanges an asset pointer for a signed download URL', async () => {
  const fetchImpl = async (url, opts) => {
    if (url === '/api/auth/session') return { ok: true, json: async () => ({ accessToken: 'tok-1' }) };
    if (url === '/backend-api/files/file-ABC123/download') {
      assert.equal(opts.headers.Authorization, 'Bearer tok-1');
      return { ok: true, json: async () => ({ download_url: 'https://files.example/signed' }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const url = await resolveFileDownloadUrl('file-service://file-ABC123', { fetchImpl });
  assert.equal(url, 'https://files.example/signed');
});

test('resolveFileDownloadUrl strips the sediment:// scheme the same way', async () => {
  const fetchImpl = async (url) => {
    if (url === '/api/auth/session') return { ok: true, json: async () => ({ accessToken: null }) };
    assert.equal(url, '/backend-api/files/file_XYZ/download');
    return { ok: true, json: async () => ({ download_url: 'https://files.example/other' }) };
  };
  const url = await resolveFileDownloadUrl('sediment://file_XYZ', { fetchImpl });
  assert.equal(url, 'https://files.example/other');
});

test('resolveFileDownloadUrl fails loudly on an unexpected response shape', async () => {
  const fetchImpl = async (url) => (url.includes('auth/session') ? { ok: true, json: async () => ({}) } : { ok: true, json: async () => ({ nope: true }) });
  await assert.rejects(resolveFileDownloadUrl('file-service://file-XYZ', { fetchImpl }), /download_url/);
});

test('resolveFileDownloadUrl fails loudly on a non-ok HTTP status', async () => {
  const fetchImpl = async (url) => (url.includes('auth/session') ? { ok: true, json: async () => ({}) } : { ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(resolveFileDownloadUrl('file-service://file-XYZ', { fetchImpl }), /HTTP 404/);
});

test('resolveFileDownloadUrl rejects an asset pointer with no file id', async () => {
  await assert.rejects(
    resolveFileDownloadUrl('', { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }),
    /asset_pointer/
  );
});


// -- multi-account / read-any-chat helpers -------------------------------------
import { identityFromSession, imagesInMessages, parseProjectSidebar } from '../extension/lib/api-capture.js';

test('identityFromSession keeps only identity fields and rejects a logged-out session', () => {
  const id = identityFromSession({ user: { id: 'user-1', email: 'a@b.com', name: 'A' }, account: { id: 'acct-1', planType: 'pro' }, accessToken: 'secret' });
  assert.deepEqual(id, { user_id: 'user-1', email: 'a@b.com', name: 'A', account_id: 'acct-1', plan: 'pro' });
  assert.ok(!JSON.stringify(id).includes('secret'));
  assert.equal(identityFromSession({}), null);
  assert.equal(identityFromSession({ user: {} }), null);
});

test('imagesInMessages keeps images from tool turns (where the image generator puts them), not just assistant turns', () => {
  const refs = imagesInMessages([
    { message_id: 'u', role: 'user', attachments: [{ content_type: 'image/png', asset_pointer: 'file-service://file-up' }] },
    { message_id: 't', role: 'tool', attachments: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_gen' }] },
    { message_id: 'a', role: 'assistant', text: 'here you go' },
    { message_id: 'x', role: 'tool', attachments: [{ content_type: 'text/plain', asset_pointer: 'file-service://doc' }] },
  ]);
  assert.deepEqual(refs.map((r) => [r.message_id, r.asset_pointer]), [['u', 'file-service://file-up'], ['t', 'sediment://file_gen']]);
});

test('parseProjectSidebar reads project chats and fails loudly on an unrecognized shape', () => {
  const projects = parseProjectSidebar({ items: [{ gizmo: { gizmo: { id: 'g-p-1', display: { name: 'DoDAF' } } }, conversations: { items: [{ id: 'c1', title: 'Tabs', update_time: '2026-09-24T01:00:00Z' }] } }] });
  assert.equal(projects[0].project_name, 'DoDAF');
  assert.deepEqual(projects[0].chats[0], { id: 'c1', title: 'Tabs', update_time: '2026-09-24T01:00:00Z', project_id: 'g-p-1', project_name: 'DoDAF' });
  assert.throws(() => parseProjectSidebar({ projects: [] }), /no items array/);
  assert.throws(() => parseProjectSidebar({ items: [{ conversations: { items: [] } }] }), /no project id/);
});

// 2026-09-26/27: continued threads in a hidden tab can mount 0 messages, so
// when the pre-send tree read failed (429) the old DOM-count fallback made
// the baseline 0 and every earlier answer in the thread part of "the reply".
test('replyFromTree with an unknown baseline returns only the answer after our own prompt', () => {
  const u1 = userMsg('u1', 'earlier question', 1).message;
  const a1 = { ...assistantMsg('a1', 'earlier answer', 2).message, status: 'finished_successfully' };
  const u2 = userMsg('u2', 'our   new question about X', 3).message;
  const a2 = { ...assistantMsg('a2', 'the new answer', 4).message, status: 'finished_successfully', end_turn: true };
  const r = replyFromTree(treeOf([{ id: 'u1', message: u1 }, { id: 'a1', message: a1 }, { id: 'u2', message: u2 }, { id: 'a2', message: a2 }]), null, { expected: 'our new question about X' });
  assert.equal(r.done, true);
  assert.equal(r.reply, 'the new answer');
  assert.equal(r.end_turn, true);
});

test('replyFromTree with an unknown baseline does not return the previous answer before our turn is saved', () => {
  const u1 = userMsg('u1', 'earlier question', 1).message;
  const a1 = { ...assistantMsg('a1', 'earlier answer', 2).message, status: 'finished_successfully' };
  const r = replyFromTree(treeOf([{ id: 'u1', message: u1 }, { id: 'a1', message: a1 }]), null, { expected: 'our new question' });
  assert.equal(r.done, false);
  assert.equal(r.status, 'prompt_not_in_tree');
});

test('replyFromTree reports end_turn false when the backend did not mark the turn over', () => {
  const a1 = { ...assistantMsg('a1', 'text', 1).message, status: 'finished_successfully' };
  const r = replyFromTree(treeOf([{ id: 'a1', message: a1 }]), 0);
  assert.equal(r.done, true);
  assert.equal(r.end_turn, false);
});

test('nextReplyCheckGapMs backs off only on 429 and honours Retry-After', () => {
  assert.equal(nextReplyCheckGapMs(10000, { status: 429 }), 20000);
  assert.equal(nextReplyCheckGapMs(40000, { status: 429 }), 60000);
  assert.equal(nextReplyCheckGapMs(60000, { status: 429 }), 60000);
  assert.equal(nextReplyCheckGapMs(10000, { status: 429, retryAfterMs: 90000 }), 90000);
  assert.equal(nextReplyCheckGapMs(60000, { status: 200 }), 10000);
  assert.equal(nextReplyCheckGapMs(60000, { status: null }), 10000);
  assert.equal(nextReplyCheckGapMs(60000, { status: 500 }), 10000);
});

test('a refused conversation read reports its rate-limit headers and body', async () => {
  const { rateLimitDetail } = await import('../extension/lib/api-capture.js');
  const res = new Response('{"detail":"Too many requests"}', { status: 429, headers: { 'retry-after': '120', 'x-ratelimit-remaining': '0', 'content-type': 'application/json' } });
  const d = await rateLimitDetail(res);
  assert.equal(d.status, 429);
  assert.equal(d.headers['retry-after'], '120');
  assert.equal(d.headers['x-ratelimit-remaining'], '0');
  assert.equal(d.headers['content-type'], undefined);
  assert.match(d.body, /Too many requests/);
});

test('listProjectConversations follows the cursor to the end and dedupes', async () => {
  const { listProjectConversations } = await import('../extension/lib/api-capture.js');
  const pages = { '0': { items: [{ id: 'a' }, { id: 'b' }], cursor: '2' }, '2': { items: [{ id: 'b' }, { id: 'c' }], cursor: null } };
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); const c = new URL(url, 'https://x').searchParams.get('cursor'); return { ok: true, json: async () => pages[c] }; };
  const out = await listProjectConversations('g-1', { fetchImpl, accessToken: 't', sleepImpl: async () => {} });
  assert.deepEqual(out.map((c) => c.id), ['a', 'b', 'c']);
  assert.equal(urls.length, 2);
  await assert.rejects(listProjectConversations('g-1', { fetchImpl: async () => ({ ok: false, status: 429 }), accessToken: 't', sleepImpl: async () => {} }), /HTTP 429/);
});
