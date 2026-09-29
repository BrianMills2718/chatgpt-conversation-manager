// Did clicking ChatGPT's Send button actually submit the prompt?
//
// The content script used to treat "the composer cleared within 10s" as the
// only proof, and threw "the prompt may not have been sent" otherwise. In a
// hidden (background) tab that proof arrives late or not at all -- Chrome
// throttles the page's timers and rendering -- yet the prompt was sent: of 18
// such failures logged 2026-09-25/26, 14 have a conversation created on
// ChatGPT's side seconds later (most already answered), and 16 of the 18 ran
// with no other ask in flight. Callers retried each "failure", so every
// false failure became a duplicate chat. So a send is confirmed by ANY
// observable consequence of it, and when none is visible yet the result is
// "unconfirmed" (let the broker keep watching), never "not sent".

function norm(s) { return String(s ?? "").replace(/\s+/g, " ").trim(); }

// Returns the name of the first observable consequence of a submitted prompt,
// or null when none is visible (yet). Pure: the caller reads the page.
//   composerText   current text of the composer element
//   threadRawBefore/threadRawNow  currentThreadId() before the click and now,
//                  including ChatGPT's temporary "WEB:<uuid>" id for a new chat
//   domBefore      number of messages rendered before the click
//   domMessages    messages rendered now ([{ role, text }])
//   expected       the prompt text (or its leading slice)
export function sendEvidence({ composerText, threadRawBefore = null, threadRawNow = null, domBefore = 0, domMessages = [], expected = "" }) {
  if (norm(composerText) === "") return "composer_cleared";
  if (threadRawNow && threadRawNow !== threadRawBefore) return "thread_assigned";
  const want = norm(expected).slice(0, 40);
  const added = (domMessages || []).slice(Number(domBefore) || 0);
  if (want && added.some((m) => m?.role === "user" && norm(m.text).includes(want))) return "user_turn_rendered";
  return null;
}

// Server-side check for an existing conversation: the authoritative message
// count grew past the pre-send count, so ChatGPT received a new turn.
export function sendEvidenceFromCounts(countNow, countBefore) {
  return Number.isInteger(countNow) && Number.isInteger(countBefore) && countNow > countBefore ? "server_turn" : null;
}

// Whether two texts are the same prompt once whitespace is normalized. Used
// both for "does the composer hold exactly our prompt" and "is this user
// turn our prompt". A prefix check is not enough: callers send templated
// prompts that share thousands of leading characters, and on 2026-09-27/28 a
// 40-character prefix check let a new ask skip typing and click Send on the
// previous ask's leftover text (28 of ~195 audit replies were another
// prompt's answer).
//
// ChatGPT sometimes stores a prompt markdown-escaped: a backslash before
// markdown punctuation ("\#", "\`", "\_", "\<", "\&"), leading spaces as
// "&#x20;", and bare URLs as "[url](url)" links. 91 of 273 audit prompts,
// 2026-09-26..29, in no pattern of tab, size or mode; after
// unescapeChatgptPrompt all 91 equal the prompt file that was sent. So a turn
// is ours if it equals the prompt either as stored or once unescaped. Only
// the stored side is unescaped: the prompt itself may hold real backslashes
// (a regex "\.") and entities ("&#39;") that must stay as they are.
const MD_ESCAPE = /\\([!-\/:-@[-`{-~])/g;
const unescapeMd = (t) => t.replace(MD_ESCAPE, "$1");
export function unescapeChatgptPrompt(s) {
  return String(s ?? "")
    .replace(/(?<!\\)\[([^\]\s]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, text, url) => (unescapeMd(text) === unescapeMd(url) ? text : m))
    .replace(/&#x(20|9);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(MD_ESCAPE, "$1");
}

// ChatGPT has also stored a prompt wrapped whole in a longer code fence:
// "````\n" + prompt + "\n````" (ats4, 2026-09-29, a prompt typed and then
// switched to plain-text mode). The fence must be longer than any backtick run
// inside, so a prompt that is itself one fenced block is not stripped.
export function unwrapWholeFence(s) {
  const m = /^(`{3,})[^\S\n]*\n([\s\S]*)\n\1[^\S\n]*$/.exec(String(s ?? "").replace(/\s+$/, ""));
  if (!m) return null;
  const longestInner = Math.max(0, ...(m[2].match(/`+/g) || []).map((x) => x.length));
  return m[1].length > longestInner ? m[2] : null;
}

export function samePrompt(a, b) {
  const x = norm(a), y = norm(b);
  if (x === "" || y === "") return false;
  if (x === y || norm(unescapeChatgptPrompt(a)) === y || x === norm(unescapeChatgptPrompt(b))) return true;
  const ua = unwrapWholeFence(a), ub = unwrapWholeFence(b);
  return (ua != null && norm(ua) === y) || (ub != null && norm(ub) === x);
}

// First differing position after normalization, for error messages.
export function promptHead(s, n = 80) { return norm(s).slice(0, n); }

// Fail-closed gate before Send: `wouldSend` is ChatGPT's own getText() (what a
// click would submit), or null when it could not be read. Returns null when
// that is the prompt verbatim (trailing whitespace aside, which ChatGPT trims),
// otherwise a diagnostic. Deliberately exact: no whitespace normalization, no
// unescaping -- anything else would let an altered prompt through.
export function verbatimMismatch(wouldSend, prompt, readError = null) {
  if (wouldSend === null || wouldSend === undefined) return { reason: `could not read what ChatGPT would send: ${readError}` };
  const got = String(wouldSend).trimEnd(), want = String(prompt).trimEnd();
  if (got === want) return null;
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  return { would_send_chars: got.length, prompt_chars: want.length, first_diff: i, would_send_at: got.slice(i, i + 60), prompt_at: want.slice(i, i + 60) };
}
