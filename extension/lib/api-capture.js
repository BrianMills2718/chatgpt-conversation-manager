// Same-origin capture path: read ChatGPT's own conversation tree via the
// endpoint the chatgpt.com web app itself calls to hydrate a conversation page
// (fetch(..., { credentials: 'same-origin' })). This never touches, exports, or
// forwards session cookies anywhere — the request is made in-page, by the page's
// own origin, exactly like the ChatGPT UI's own client-side code does. It exists
// because ChatGPT virtualizes long conversations in the DOM: older turns can be
// unmounted and are not reliably recoverable by scrolling alone, so DOM scraping
// cannot guarantee complete capture of a long thread. This path can guarantee it,
// because it reads the full message tree ChatGPT itself maintains server-side for
// the conversation, not whatever happens to be currently mounted in the viewport.
//
// This is a private, undocumented, in-browser endpoint. It may change without
// notice. Every caller MUST treat failures (network, shape, HTTP status) as a
// signal to fall back to DOM capture rather than as a fatal error.
//
// Confirmed live (2026-08-19) that cookies alone are not sufficient: the
// endpoint 404s without also attaching an `Authorization: Bearer <jwt>`
// header, matching what chatgpt.com's own frontend sends. That token is
// fetched fresh per call from /api/auth/session (same origin, same session
// endpoint the page itself calls) — see getAccessToken() below.

export function looksLikeConversationTree(data) {
  return Boolean(data && typeof data === "object" && data.mapping && typeof data.mapping === "object" && typeof data.current_node === "string");
}

// ChatGPT represents native Projects as gizmos; a conversation's membership
// shows up as conversation_template_id (aka gizmo_id) on its own detail
// endpoint. Used to verify a "move to project" DOM action actually took
// effect server-side, the same way title verification confirms a rename.
export async function getConversationProjectId(threadId, { fetchImpl = fetch, accessToken } = {}) {
  if (accessToken === undefined) accessToken = await getAccessToken({ fetchImpl });
  const headers = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetchImpl(`/backend-api/conversation/${encodeURIComponent(threadId)}`, {
    method: "GET",
    credentials: "same-origin",
    headers,
  });
  if (!res.ok) throw new Error(`conversation fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.conversation_template_id || data.gizmo_id || null;
}

// The backend-api conversation endpoint 404s without this: ChatGPT's own
// frontend attaches a short-lived JWT (fetched from its own same-origin
// session endpoint, the same one the page itself calls on load) as a Bearer
// token on top of cookies. Fetched fresh per capture and never persisted or
// forwarded anywhere — it lives only for the duration of this one request.
export async function getAccessToken({ fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl("/api/auth/session", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.accessToken === "string" ? data.accessToken : null;
  } catch {
    return null;
  }
}

// accessToken: pass a pre-fetched token to skip the /api/auth/session round trip
// (used by bulk operations iterating many conversations with one shared token).
// Pass null explicitly to force an unauthenticated request; omit to fetch fresh.
export async function fetchConversationTree(threadId, { fetchImpl = fetch, accessToken } = {}) {
  if (!threadId) throw new Error("fetchConversationTree requires a thread id");
  if (accessToken === undefined) accessToken = await getAccessToken({ fetchImpl });
  const headers = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetchImpl(`/backend-api/conversation/${encodeURIComponent(threadId)}`, {
    method: "GET",
    credentials: "same-origin",
    headers,
  });
  if (!res.ok) {
    throw Object.assign(new Error(`backend-api conversation fetch failed: HTTP ${res.status}`), {
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers?.get?.("retry-after")),
    });
  }
  const data = await res.json();
  if (!looksLikeConversationTree(data)) throw new Error("backend-api conversation response did not look like a conversation tree (schema may have changed)");
  return data;
}

function extractText(message) {
  const parts = message?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => typeof p === "string")
    .join("\n\n")
    .trim();
}

function extractAttachments(message) {
  const parts = message?.content?.parts;
  const attachments = [];
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (p && typeof p === "object" && (p.asset_pointer || p.content_type)) {
        attachments.push({
          content_type: p.content_type || null,
          asset_pointer: p.asset_pointer || null,
          name: p.file_name || p.name || null,
        });
      }
    }
  }
  const attachmentMeta = message?.metadata?.attachments;
  if (Array.isArray(attachmentMeta)) {
    for (const a of attachmentMeta) {
      attachments.push({ content_type: a?.mime_type || null, name: a?.name || null, id: a?.id || null });
    }
  }
  return attachments;
}

// ChatGPT marks a generated (or uploaded) image part with content_type
// "image_asset_pointer" (asset_pointer like "file-service://file-XXXX" or
// "sediment://file_XXXX"), or occasionally a plain "image/..." mime type in the
// metadata.attachments list. Either way the pointer/id alone is not a fetchable
// URL -- resolveFileDownloadUrl (below) exchanges it for one.
function isImageAttachment(a) {
  return Boolean(
    a && (a.content_type === "image_asset_pointer" || (typeof a.content_type === "string" && a.content_type.startsWith("image/")))
  );
}

// Walks the parent chain from current_node back to the root (the branch ChatGPT
// is actually showing), then reverses it into chronological order. This follows
// only the currently-selected branch, matching what the DOM would render, but
// without depending on what is actually mounted.
export function linearizeMapping(data) {
  const mapping = data?.mapping || {};
  const currentNode = data?.current_node;
  if (!currentNode || !mapping[currentNode]) throw new Error("conversation mapping has no resolvable current_node");

  const chain = [];
  const guard = new Set();
  let nodeId = currentNode;
  while (nodeId && mapping[nodeId]) {
    if (guard.has(nodeId)) break; // cycle guard against malformed trees
    guard.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }
  chain.reverse();

  const messages = [];
  for (const node of chain) {
    const message = node.message;
    if (!message) continue; // synthetic root node carries no message
    const role = message.author?.role;
    if (!role || role === "system") continue;
    const recipient = message.recipient;
    if (recipient && recipient !== "all") continue; // tool-directed/hidden turns
    const text = extractText(message);
    const attachments = extractAttachments(message);
    if (!text && !attachments.length) continue;
    messages.push({
      message_id: node.id,
      role,
      text,
      created_at: typeof message.create_time === "number" ? new Date(message.create_time * 1000).toISOString() : null,
      model: message.metadata?.model_slug || null,
      attachments: attachments.length ? attachments : undefined,
    });
  }
  return messages;
}

export async function captureViaApi(threadId, { fetchImpl = fetch, accessToken } = {}) {
  const data = await fetchConversationTree(threadId, { fetchImpl, accessToken });
  const messages = linearizeMapping(data);
  return { title: typeof data.title === "string" ? data.title : null, messages };
}

// ask_chatgpt: decide from ChatGPT's own conversation tree whether the reply to
// a message we sent has finished, and extract it. `beforeCount` is how many
// linearized messages the thread had before sending (0 for a new chat). Done
// only when the current node is an assistant message the backend marks finished
// (status finished_successfully, or end_turn true) AND new messages exist beyond
// our own; anything else is "not yet", with the observed status for diagnosis.
//
// `beforeCount` null means the pre-send count is unknown (the pre-send read of
// a continued thread failed, e.g. HTTP 429). The mounted-DOM count is not a
// substitute: a hidden tab can report 0, which made every earlier answer in
// the thread part of "the reply". Instead the reply is what follows the last
// user message, and when `expected` (the prompt's opening text) is given that
// user message must be ours, so a read that lands before our turn is saved
// cannot return the previous answer.
//
// `end_turn` is reported so the broker can accept the backend's own "this
// turn is over" without spending a second read to confirm it.
function normText(s) { return String(s ?? "").replace(/\s+/g, " ").trim(); }

export function replyFromTree(data, beforeCount, { expected = null } = {}) {
  const node = data?.mapping?.[data?.current_node];
  const message = node?.message;
  const role = message?.author?.role || null;
  const status = message?.status || null;
  const finished = role === "assistant" && (status === "finished_successfully" || message?.end_turn === true);
  const messages = linearizeMapping(data);
  let added;
  if (beforeCount == null) {
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { lastUser = i; break; }
    const want = normText(expected).slice(0, 40);
    if (lastUser < 0 || (want && !normText(messages[lastUser].text).includes(want))) {
      return { done: false, role, status: lastUser < 0 ? status : "prompt_not_in_tree", message_count: messages.length };
    }
    added = messages.slice(lastUser + 1);
  } else {
    added = messages.slice(beforeCount);
  }
  const replies = added.filter((m) => m.role === "assistant");
  if (!finished || replies.length === 0) {
    return { done: false, role, status, message_count: messages.length };
  }
  const images = replies.flatMap((m) => (m.attachments || []).filter(isImageAttachment));
  return { done: true, reply: replies.map((m) => m.text).join("\n\n"), message_count: messages.length,
           model: replies[replies.length - 1].model || null, end_turn: message?.end_turn === true,
           images: images.length ? images : undefined };
}

// Exchanges an asset_pointer (file-service://file-XXXX or sediment://file_XXXX)
// for the short-lived signed download URL ChatGPT's own UI fetches when a
// generated or uploaded image is opened. Same same-origin + bearer-token
// pattern as fetchConversationTree above.
//
// UNCONFIRMED against a live account as of 2026-09-23 -- built from the known
// shape of ChatGPT's file-serving endpoint, not from a live capture (no
// browser session was available while writing this). Every caller MUST treat
// a failure or an unexpected response shape as "this image is unavailable"
// and still return the text reply, exactly like fetchConversationTree's own
// callers are required to do -- never as fatal.
export async function resolveFileDownloadUrl(assetPointer, { fetchImpl = fetch, accessToken } = {}) {
  const fileId = String(assetPointer || "").replace(/^(file-service|sediment):\/\//, "");
  if (!fileId) throw new Error("resolveFileDownloadUrl requires an asset_pointer with a file id");
  if (accessToken === undefined) accessToken = await getAccessToken({ fetchImpl });
  const headers = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetchImpl(`/backend-api/files/${encodeURIComponent(fileId)}/download`, {
    method: "GET",
    credentials: "same-origin",
    headers,
  });
  if (!res.ok) throw new Error(`file download-url fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  if (typeof data?.download_url !== "string") throw new Error("file download response did not include download_url (schema may have changed)");
  return data.download_url;
}

// Retry-After is either delay-seconds or an HTTP date. Returns ms or null.
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

// AIMD pacing for bulk fetches, the way TCP finds a link's capacity: every
// success shortens the gap a little, every 429 doubles it. The gap settles just
// under the rate ChatGPT tolerates instead of a guessed constant. `stats` is
// reported in progress messages so the learned rate is observable.
export class AdaptivePacer {
  constructor({ initialMs = 2500, minMs = 300, maxMs = 120000, decreaseFactor = 0.9, increaseFactor = 2 } = {}) {
    Object.assign(this, { minMs, maxMs, decreaseFactor, increaseFactor });
    this.spacingMs = Math.min(maxMs, Math.max(minMs, initialMs));
    this.rateLimited = 0;
    this.successes = 0;
  }
  onSuccess() {
    this.successes++;
    this.spacingMs = Math.max(this.minMs, Math.round(this.spacingMs * this.decreaseFactor));
  }
  // Returns how long to wait before retrying the throttled request.
  onRateLimit(retryAfterMs = null) {
    this.rateLimited++;
    this.spacingMs = Math.min(this.maxMs, Math.max(1000, Math.round(this.spacingMs * this.increaseFactor)));
    return retryAfterMs != null ? Math.min(this.maxMs, Math.max(retryAfterMs, this.spacingMs)) : this.spacingMs;
  }
  stats() {
    return { spacing_ms: this.spacingMs, rate_limited: this.rateLimited, successes: this.successes };
  }
}

// Bulk-capture one conversation: an expired access token (401/403) is refreshed
// once; a 429 feeds the pacer and retries after its wait. If one conversation
// is throttled `maxRateLimitRetries` times in a row even at growing spacing,
// the error is marked `abortRun` so the caller stops rather than failing every
// remaining conversation while still throttled.
export async function captureWithRecovery(threadId, { tokenRef, pacer, capture = captureViaApi, refreshToken = getAccessToken, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRateLimitRetries = 8 } = {}) {
  let refreshed = false;
  let throttled = 0;
  for (;;) {
    try {
      const result = await capture(threadId, { accessToken: tokenRef.token });
      pacer.onSuccess();
      return result;
    } catch (err) {
      if ((err.status === 401 || err.status === 403) && !refreshed) {
        refreshed = true;
        tokenRef.token = await refreshToken();
        continue;
      }
      if (err.status === 429) {
        const wait = pacer.onRateLimit(err.retryAfterMs ?? null);
        if (++throttled > maxRateLimitRetries) {
          throw Object.assign(new Error(`rate limited (HTTP 429) ${throttled} times in a row; spacing reached ${pacer.spacingMs}ms`), { status: 429, abortRun: true });
        }
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

// Same-origin conversation-list endpoint (the one the sidebar itself paginates
// through). Used for bulk archival: lets us enumerate every conversation the
// account has without opening each one in a tab first.
export function looksLikeConversationList(data) {
  return Boolean(data && typeof data === "object" && Array.isArray(data.items));
}

export async function listConversationsPage({ offset = 0, limit = 28, fetchImpl = fetch, accessToken } = {}) {
  if (accessToken === undefined) accessToken = await getAccessToken({ fetchImpl });
  const headers = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetchImpl(`/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`, {
    method: "GET",
    credentials: "same-origin",
    headers,
  });
  if (!res.ok) throw new Error(`conversations list fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!looksLikeConversationList(data)) throw new Error("conversations list response did not look like the expected shape (schema may have changed)");
  return data; // { items: [{id, title, create_time, update_time, ...}], total, limit, offset }
}

// ChatGPT's list endpoint has returned update_time both as epoch seconds and as
// an ISO string; accept either. Returns epoch ms, or null when unparseable.
export function parseRemoteTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    const n = Number(value);
    if (Number.isFinite(n)) return parseRemoteTime(n);
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

// Incremental sync: keep only conversations that are new, or whose remote
// update_time is later than when the archive last captured them. `known` maps
// thread id -> last_captured_at (ISO). An unparseable update_time is treated as
// changed, so a schema drift re-fetches rather than silently skipping.
export function selectChangedConversations(items, known = {}) {
  return items.filter((c) => {
    const capturedMs = known[c.id] ? Date.parse(known[c.id]) : NaN;
    if (Number.isNaN(capturedMs)) return true;
    const updatedMs = parseRemoteTime(c.update_time);
    return updatedMs === null || updatedMs > capturedMs;
  });
}

// Pages through the full conversation list once, sharing one access token
// across all page requests. onPage(loadedSoFar, total) is called after each
// page for progress reporting.
export async function listAllConversations({ fetchImpl = fetch, pageSize = 50, onPage } = {}) {
  const accessToken = await getAccessToken({ fetchImpl });
  const seen = new Set();
  const all = [];
  let offset = 0;
  // Hard cap as a runaway-loop backstop; a real account is not going to have
  // more than this many conversations, and if the server never signals a
  // clean end we must not loop forever.
  for (let guard = 0; guard < 500; guard++) {
    const page = await listConversationsPage({ offset, limit: pageSize, fetchImpl, accessToken });
    let newCount = 0;
    for (const c of page.items) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      all.push(c);
      newCount++;
    }
    if (onPage) onPage(all.length, page.total);
    // Live testing showed the server can return non-empty but entirely
    // already-seen pages past the real end (order=updated pagination is not
    // stable under concurrent activity), so `items.length < pageSize` alone
    // is not a safe stop condition — a page contributing zero *new* ids is
    // the only reliable signal that we've reached the end.
    if (page.items.length < pageSize || newCount === 0) break;
    offset += page.items.length;
  }
  return all;
}

// -- multi-account / read-any-chat support -------------------------------------
// A ChatGPT conversation lives server-side, not in a tab: any tab logged into
// the same account can read any of that account's conversations by id, no
// matter where it was started (another browser, the desktop app, a phone).
// The broker therefore needs to know which account each connected tab is
// signed into, so it can route a read/ask to a tab that can actually see the
// conversation. /api/auth/session is the same same-origin endpoint
// getAccessToken() already reads; this only keeps its identity fields.
export function identityFromSession(data) {
  const user = data?.user;
  if (!user || typeof user !== "object") return null;
  const email = typeof user.email === "string" ? user.email : null;
  const userId = typeof user.id === "string" ? user.id : null;
  if (!email && !userId) return null;
  return {
    user_id: userId,
    email,
    name: typeof user.name === "string" ? user.name : null,
    account_id: typeof data?.account?.id === "string" ? data.account.id : null,
    plan: typeof data?.account?.planType === "string" ? data.account.planType : null,
  };
}

export async function getSessionIdentity({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl("/api/auth/session", { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`session fetch failed: HTTP ${res.status}`);
  const identity = identityFromSession(await res.json());
  if (!identity) throw new Error("session response carried no signed-in user (logged out, or schema changed)");
  return identity;
}

// Every image anywhere in a linearized conversation -- generated images arrive
// on tool-authored turns (the image generator), not only on assistant turns,
// so this deliberately does not filter by role the way replyFromTree does.
export function imagesInMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    for (const a of m.attachments || []) {
      if (isImageAttachment(a) && a.asset_pointer) out.push({ message_id: m.message_id, role: m.role, asset_pointer: a.asset_pointer, name: a.name || null });
    }
  }
  return out;
}

// ChatGPT's main conversation list (/backend-api/conversations) leaves out
// chats filed inside a Project, so a list built only from it is blind to
// them. The Projects sidebar endpoint returns each project with its recent
// conversations. UNCONFIRMED against a live account as of 2026-09-24: the
// shape below is parsed defensively and anything unrecognized throws, so a
// schema change fails loudly instead of silently returning "no project chats".
export function parseProjectSidebar(data) {
  const items = data?.items;
  if (!Array.isArray(items)) throw new Error("projects sidebar response has no items array (schema may have changed)");
  return items.map((item) => {
    const g = item?.gizmo?.gizmo || item?.gizmo || {};
    const convs = item?.conversations?.items || item?.gizmo?.conversations?.items || [];
    if (!g.id) throw new Error("projects sidebar item has no project id (schema may have changed)");
    return {
      project_id: g.id,
      project_name: g.display?.name || g.name || null,
      chats: (Array.isArray(convs) ? convs : []).map((c) => ({ id: c.id, title: c.title || "", update_time: c.update_time ?? null, project_id: g.id, project_name: g.display?.name || g.name || null })),
    };
  });
}

export async function listProjectChats({ perProject = 20, fetchImpl = fetch, accessToken } = {}) {
  if (accessToken === undefined) accessToken = await getAccessToken({ fetchImpl });
  const headers = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetchImpl(`/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=${encodeURIComponent(perProject)}`, { method: "GET", credentials: "same-origin", headers });
  if (!res.ok) throw new Error(`projects sidebar fetch failed: HTTP ${res.status}`);
  return parseProjectSidebar(await res.json());
}

// How long ask_chatgpt's reply check waits before its next conversation-tree
// read. Normally 10s. A throttled read (HTTP 429) doubles the gap up to 60s,
// or waits as long as the server's own Retry-After says, instead of reading
// every 10s regardless: on 2026-09-26/27 five of every six reads while
// throttled were 429s that only spent the account's quota. Any other outcome
// returns to 10s.
export const REPLY_CHECK_MIN_GAP_MS = 10000;
export const REPLY_CHECK_MAX_GAP_MS = 60000;
export function nextReplyCheckGapMs(gapMs, { status = null, retryAfterMs = null } = {}) {
  if (status !== 429) return REPLY_CHECK_MIN_GAP_MS;
  const doubled = Math.min(REPLY_CHECK_MAX_GAP_MS, Math.max(REPLY_CHECK_MIN_GAP_MS, Number(gapMs) || 0) * 2);
  return Number.isFinite(retryAfterMs) ? Math.max(doubled, retryAfterMs) : doubled;
}
