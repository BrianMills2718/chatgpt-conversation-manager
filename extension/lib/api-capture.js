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
export function replyFromTree(data, beforeCount) {
  const node = data?.mapping?.[data?.current_node];
  const message = node?.message;
  const role = message?.author?.role || null;
  const status = message?.status || null;
  const finished = role === "assistant" && (status === "finished_successfully" || message?.end_turn === true);
  const messages = linearizeMapping(data);
  const added = messages.slice(beforeCount);
  const replies = added.filter((m) => m.role === "assistant");
  if (!finished || replies.length === 0) {
    return { done: false, role, status, message_count: messages.length };
  }
  return { done: true, reply: replies.map((m) => m.text).join("\n\n"), message_count: messages.length,
           model: replies[replies.length - 1].model || null };
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
