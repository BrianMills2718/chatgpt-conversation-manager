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
