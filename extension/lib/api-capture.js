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
  if (!res.ok) throw new Error(`backend-api conversation fetch failed: HTTP ${res.status}`);
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
