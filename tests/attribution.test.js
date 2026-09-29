// Reply attribution and account resolution for ask_chatgpt (issues #27, #28).
// Own broker instance, like multi-account.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { replyFromTree } from '../extension/lib/api-capture.js';
import { samePrompt } from '../extension/lib/send-confirm.js';

// Two audit prompts from 2026-09-27 shared a long templated head and differed
// only in the repo named later; that is the case a prefix check gets wrong.
const HEAD = 'Correctness-only bug audit (no style, naming, docs, or "consider adding" suggestions). Below is source from the repo ';
const PF2 = `${HEAD}portfolio (Brian's portfolio site) ...files...`;
const NEVER_ABSOLUTE = `${HEAD}never-absolute (a library) ...other files...`;

function msg(id, role, text, extra = {}) {
  return { id, message: { id, author: { role }, content: { content_type: 'text', parts: [text] }, create_time: 1, ...extra } };
}
function tree(nodes) {
  const mapping = {};
  let parent = null;
  for (const n of nodes) { mapping[n.id] = { id: n.id, parent, children: [], message: n.message }; if (parent) mapping[parent].children.push(n.id); parent = n.id; }
  return { mapping, current_node: parent };
}
const finished = { status: 'finished_successfully', end_turn: true };

test('samePrompt compares whole prompts, not a shared head, ignoring whitespace', () => {
  assert.equal(samePrompt(PF2, `  ${PF2.replace(/ /g, '\n')} `), true);
  assert.equal(samePrompt(PF2, NEVER_ABSOLUTE), false);
  assert.equal(samePrompt('', ''), false);
});

test('replyFromTree refuses a new chat whose prompt is another ask\'s (the pf2 / never-absolute case)', () => {
  // pf2's ask clicked Send on never-absolute's leftover text: the new chat
  // holds never-absolute's prompt and its finished answer.
  const t = tree([msg('u1', 'user', NEVER_ABSOLUTE), msg('a1', 'assistant', 'NO HIGH-CONFIDENCE BUGS', finished)]);
  const r = replyFromTree(t, 0, { expected: PF2 });
  assert.equal(r.done, false);
  assert.equal(r.status, 'prompt_mismatch');
  assert.match(r.found_prompt_head, /never-absolute/);
  // Our own prompt in the same position is accepted.
  const ok = replyFromTree(tree([msg('u1', 'user', PF2), msg('a1', 'assistant', 'findings', finished)]), 0, { expected: PF2 });
  assert.equal(ok.done, true);
  assert.equal(ok.reply, 'findings');
});

test('replyFromTree waits (not mismatch) while our turn is not in the tree yet', () => {
  const t = tree([msg('u1', 'user', 'earlier'), msg('a1', 'assistant', 'earlier answer', finished)]);
  const r = replyFromTree(t, 2, { expected: PF2 });
  assert.equal(r.done, false);
  assert.equal(r.status, 'prompt_not_in_tree');
});

test('replyFromTree with an unknown baseline no longer matches on a 40-character prefix', () => {
  const t = tree([msg('u1', 'user', NEVER_ABSOLUTE), msg('a1', 'assistant', 'their answer', finished)]);
  assert.equal(replyFromTree(t, null, { expected: PF2 }).done, false);
});

// ---- broker level ----------------------------------------------------------
const TOKEN = 'attribution-token';
let mod, server, wsUrl;
const sockets = [];
before(async () => {
  process.env.PORT = '0';
  process.env.RENAMER_TOKEN = TOKEN;
  process.env.ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-attr-'));
  process.env.RETRY_CLICK_AFTER_MS = '60,120';
  mod = await import('../server/index.js');
  server = mod.server;
  await new Promise((resolve) => (server.listening ? resolve() : server.listen(0, resolve)));
  wsUrl = `ws://127.0.0.1:${server.address().port}/extension?token=${TOKEN}`;
  mod.agentPacer.minMs = 0; mod.agentPacer.spacingMs = 0;
});
after(() => { for (const ws of sockets) ws.close(); server.close(); });

function agentTab(token, email, handlers) {
  const received = [];
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsUrl}&tab=${token}&agent=1`);
    sockets.push(ws);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'identity', account: { email, user_id: `user-${email}` } }));
      setTimeout(() => resolve({ ws, received, close: () => ws.close() }), 50);
    });
    ws.on('message', async (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type !== 'command') return;
      received.push(m);
      const reply = (extra) => ws.send(JSON.stringify({ type: 'command_result', id: m.id, tab: token, agent: true, ...extra }));
      if (m.action === 'get_tab') return reply({ ok: true, tab: token, agent: true, busy: false, thread_id: null, account: { email } });
      const h = handlers[m.action];
      if (!h) return reply({ ok: false, error: `unhandled ${m.action}` });
      reply({ ok: true, ...(await h(m)) });
    });
  });
}

test('an ask with no account is paced and logged under the tab\'s own account, and passes the whole prompt for attribution', async () => {
  const t = await agentTab('acct-tab-1', 'Someone@Example.com', {
    send_prompt: () => ({ thread_id: 'conv-1', dom_before: 0, messages_before: 0, send_confirmed: true, confirmed_by: 'thread_assigned' }),
    get_reply: () => ({ done: true, source: 'api', end_turn: true, reply: 'fine', thread_id: 'conv-1' }),
  });
  try {
    const r = await mod.askChatgpt({ text: PF2, timeout_seconds: 10, pollMs: 20 });
    assert.equal(r.reply, 'fine');
    assert.equal(r.account.toLowerCase(), 'someone@example.com');
    const getReply = t.received.find((m) => m.action === 'get_reply');
    assert.equal(getReply.expected, PF2, 'the extension must receive the whole prompt, not a 200-character slice');
    const timing = fs.readFileSync(mod.REQUEST_TIMING_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const send = timing.find((e) => e.action === 'send_prompt');
    assert.equal(send.account, 'someone@example.com');
    const events = fs.readFileSync(mod.BRIDGE_OBSERVATIONS_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(events.at(-1).account.toLowerCase(), 'someone@example.com');
  } finally { t.close(); await new Promise((r) => setTimeout(r, 50)); }
});

test('a reply whose conversation holds a different prompt fails at once without claiming the prompt was sent', async () => {
  const t = await agentTab('mismatch-tab-1', 'a@example.com', {
    send_prompt: () => ({ thread_id: null, dom_before: 0, messages_before: 0, send_confirmed: true, confirmed_by: 'composer_cleared' }),
    get_reply: () => ({ done: false, source: 'api', prompt_mismatch: true, thread_id: 'conv-x', found_prompt_head: 'Correctness-only bug audit ... never-absolute', found_prompt_chars: 65781 }),
  });
  try {
    const started = Date.now();
    await assert.rejects(mod.askChatgpt({ text: PF2, timeout_seconds: 30, pollMs: 20 }), (err) => {
      assert.match(err.message, /Refusing to return a reply/);
      assert.equal(err.sent, null, 'a mismatch says nothing about whether our prompt landed');
      assert.equal(err.thread_id, 'conv-x');
      return true;
    });
    assert.ok(Date.now() - started < 5000, 'must not wait out the timeout');
  } finally { t.close(); await new Promise((r) => setTimeout(r, 50)); }
});

test('an ask that failed before clicking Send reports sent=false over REST', async () => {
  const t = await agentTab('notsent-tab-1', 'b@example.com', {});
  // Replace the handler: send_prompt fails with the extension's verified-not-sent report.
  t.ws.removeAllListeners('message');
  t.ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.type !== 'command') return;
    const reply = (extra) => t.ws.send(JSON.stringify({ type: 'command_result', id: m.id, tab: 'notsent-tab-1', agent: true, ...extra }));
    if (m.action === 'get_tab') return reply({ ok: true, tab: 'notsent-tab-1', agent: true, busy: false, thread_id: null, account: { email: 'b@example.com' } });
    if (m.action === 'send_prompt') return reply({ ok: false, error: 'no enabled send button found within 8s (...); the composer was cleared and nothing was sent.', stage: 'no_send_button', nothing_sent: true });
    reply({ ok: false, error: `unhandled ${m.action}` });
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ask`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', timeout_seconds: 10 }),
    });
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.sent, false);
    assert.equal(body.account, 'b@example.com');
    assert.match(body.error, /nothing was sent/);
  } finally { t.close(); }
});

test('an unconfirmed new-chat send found server-side is followed to its reply', async () => {
  const gets = [];
  const t = await agentTab('discover-tab-1', 'c@example.com', {
    send_prompt: () => ({ thread_id: null, dom_before: 0, messages_before: 0, send_confirmed: false, confirmed_by: null }),
    get_reply: (m) => {
      gets.push(m);
      if (!m.thread_hint) return { done: false, source: 'server_discovery', thread_id: 'conv-found', discovered_thread_id: 'conv-found' };
      return { done: true, source: 'api', end_turn: true, reply: 'late but ours', thread_id: 'conv-found' };
    },
  });
  try {
    const r = await mod.askChatgpt({ text: 'discover me', timeout_seconds: 10, pollMs: 20 });
    assert.equal(r.reply, 'late but ours');
    assert.equal(r.thread_id, 'conv-found');
    assert.equal(gets.at(-1).thread_hint, 'conv-found', 'later polls must follow the discovered conversation');
    assert.ok(gets.at(-1).exclude_threads.includes('conv-found'), 'no other ask may claim this conversation');
  } finally { t.close(); await new Promise((r) => setTimeout(r, 50)); }
});

test('a new agent tab whose account arrives after it connects still paces and logs under that account', async () => {
  const token = 'late-identity-tab';
  const ws = new WebSocket(`${wsUrl}&tab=${token}&agent=1`);
  sockets.push(ws);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.type !== 'command') return;
    const reply = (extra) => ws.send(JSON.stringify({ type: 'command_result', id: m.id, tab: token, agent: true, ...extra }));
    // get_tab carries no account yet, like a tab that has not read its session.
    if (m.action === 'get_tab') return reply({ ok: true, tab: token, agent: true, busy: false, thread_id: null, account: null });
    if (m.action === 'send_prompt') return reply({ ok: true, thread_id: 'conv-late', dom_before: 0, messages_before: 0, send_confirmed: true });
    if (m.action === 'get_reply') return reply({ ok: true, done: true, source: 'api', end_turn: true, reply: 'ok', thread_id: 'conv-late' });
    reply({ ok: false, error: `unhandled ${m.action}` });
  });
  setTimeout(() => ws.send(JSON.stringify({ type: 'identity', account: { email: 'late@example.com' } })), 300);
  try {
    const r = await mod.askChatgpt({ text: 'late identity', timeout_seconds: 10, pollMs: 20 });
    assert.equal(r.account, 'late@example.com');
  } finally { ws.close(); await new Promise((r) => setTimeout(r, 50)); }
});

test('an unconfirmed click is retried only through the server-checked retry, and followed once it lands', async () => {
  const retries = [];
  const t = await agentTab('retry-tab-1', 'r@example.com', {
    send_prompt: () => ({ thread_id: null, dom_before: 0, messages_before: 0, send_confirmed: false, confirmed_by: null }),
    retry_send_click: (m) => {
      retries.push(m);
      return retries.length === 1 ? { clicked: true } : { clicked: false, confirmed_by: 'server_new_chat', thread_id: 'conv-r' };
    },
    get_reply: (m) => (m.thread_hint === 'conv-r'
      ? { done: true, source: 'api', end_turn: true, reply: 'answer after re-click', thread_id: 'conv-r' }
      : { done: false, source: 'dom', thread_id: null }),
  });
  try {
    const r = await mod.askChatgpt({ text: 'big prompt', timeout_seconds: 10, pollMs: 20 });
    assert.equal(r.reply, 'answer after re-click');
    assert.equal(retries.length, 2);
    assert.equal(retries[0].expected, 'big prompt');
    const events = fs.readFileSync(mod.BRIDGE_OBSERVATIONS_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(events.at(-1).retry_clicks.map((x) => x.clicked), [true, false]);
  } finally { t.close(); await new Promise((r) => setTimeout(r, 50)); }
});

test('an unconfirmed send that never shows up times out as sent=unknown, not sent=false', async () => {
  const t = await agentTab('never-tab-1', 'n@example.com', {
    send_prompt: () => ({ thread_id: null, dom_before: 0, messages_before: 0, send_confirmed: false, confirmed_by: null }),
    retry_send_click: () => ({ clicked: false, reason: 'composer_no_longer_holds_prompt' }),
    get_reply: () => ({ done: false, source: 'dom', thread_id: null }),
  });
  try {
    await assert.rejects(mod.askChatgpt({ text: 'lost prompt', timeout_seconds: 1, pollMs: 20 }), (err) => {
      assert.match(err.message, /Could not confirm/);
      assert.equal(err.sent, null);
      return true;
    });
  } finally { t.close(); await new Promise((r) => setTimeout(r, 50)); }
});

// Live case (wz6, 2026-09-29 05:31Z, chat 6abb4dcf): ChatGPT stored the sent
// prompt markdown-escaped -- "\###", "\`\`\`", "\_", leading spaces as
// "&#x20;", bare URLs turned into [url](url) links. 91 of 273 archived audit
// prompts were stored this way. It is our prompt; exact comparison refused it
// as another ask's (prompt_mismatch) and the ask failed with sent=unknown.
const SENT = [
  `${HEAD}wizmap (pipeline).`,
  '### FILE: wizmap_pipeline.py',
  '```',
  '#!/usr/bin/env python3',
  '# Open: https://poloclub.github.io/wizmap/?dataURL=http://localhost:8080/data.ndjson&gridURL=http://localhost:8080/grid.json',
  'def main():',
  '    if __name__ == "__main__" and x < 3 * y:',
  '        return {"a": [1, 2]}',
  '```',
].join('\n');
const STORED = [
  `${HEAD}wizmap (pipeline).`,
  '\\### FILE: wizmap\\_pipeline.py',
  '\\`\\`\\`',
  '\\#!/usr/bin/env python3',
  '\\# Open: [https://poloclub.github.io/wizmap/?dataURL=http://localhost:8080/data.ndjson&gridURL=http://localhost:8080/grid.json](https://poloclub.github.io/wizmap/?dataURL=http://localhost:8080/data.ndjson&gridURL=http://localhost:8080/grid.json)',
  'def main():',
  '&#x20;   if \\_\\_name\\_\\_ == "\\_\\_main\\_\\_" and x \\< 3 \\* y:',
  '&#x20;       return {"a": \\[1, 2]}',
  '\\`\\`\\`',
].join('\n');

test('a prompt ChatGPT stored markdown-escaped is still recognized as ours, and flagged', () => {
  assert.equal(samePrompt(SENT, STORED), true);
  const r = replyFromTree(tree([msg('u1', 'user', STORED), msg('a1', 'assistant', 'findings', finished)]), 0, { expected: SENT });
  assert.equal(r.done, true);
  assert.equal(r.reply, 'findings');
  assert.equal(r.prompt_escaped, true);
  const plain = replyFromTree(tree([msg('u1', 'user', SENT), msg('a1', 'assistant', 'findings', finished)]), 0, { expected: SENT });
  assert.equal(plain.prompt_escaped, undefined);
});

test('escaping tolerance does not blur two different prompts', () => {
  assert.equal(samePrompt(SENT, STORED.replace('wizmap (pipeline)', 'never-absolute (a library)')), false);
  assert.equal(samePrompt(SENT, STORED.replace('x \\< 3', 'x \\> 3')), false);
});

test('real backslashes and entities in the prompt survive the comparison (regex, HTML-escape map)', () => {
  // As sent: a shell regex and a JS escape map. As stored: ChatGPT escaped the
  // backslashes and the autolinked URL's "&" but left "&#39;" alone.
  const sent = `${HEAD}x.\ngit config --get-regexp '^submodule\\..*\\.path$'\nmap = {"'": "&#39;"}\nsee https://a.example/?p=1&q=2 now`;
  const stored = `${HEAD}x.\ngit config --get-regexp '^submodule\\\\..\\*\\\\.path$'\nmap = {"'": "&#39;"}\nsee [https://a.example/?p=1&q=2](https://a.example/?p=1\\&q=2) now`;
  assert.equal(samePrompt(sent, stored), true);
  assert.equal(samePrompt(stored, sent), true);
});

test('a tab that never answers send_prompt fails loudly as a stalled tab with sent=unknown', async () => {
  const t = await agentTab('stall-tab-1', 's@example.com', { send_prompt: () => new Promise(() => {}) });
  try {
    await assert.rejects(mod.askChatgpt({ text: 'x'.repeat(5000), timeout_seconds: 10, pollMs: 20, sendTimeoutMs: 300 }), (err) => {
      assert.match(err.message, /stopped responding while typing or sending this 5000-character prompt/);
      assert.equal(err.sent, null);
      return true;
    });
  } finally { t.close(); await new Promise((r) => setTimeout(r, 50)); }
});

test('the result says whether the prompt reached ChatGPT verbatim, and why not', async () => {
  const t = await agentTab('verbatim-tab-1', 'v@example.com', {
    send_prompt: () => ({ thread_id: 'conv-v', dom_before: 0, messages_before: 0, send_confirmed: true, plain_text_mode: 'composer controller not found in the React tree' }),
    get_reply: () => ({ done: true, source: 'api', end_turn: true, reply: 'r', thread_id: 'conv-v', prompt_escaped: true }),
  });
  try {
    const r = await mod.askChatgpt({ text: 'see https://example.com', timeout_seconds: 10, pollMs: 20 });
    assert.equal(r.prompt_verbatim, false);
    assert.match(r.plain_text_mode_error, /controller not found/);
  } finally { t.close(); await new Promise((r) => setTimeout(r, 50)); }
});
