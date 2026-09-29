// Chrome content scripts run as classic (non-module) scripts — "type": "module"
// is only valid for background service workers, not content_scripts entries, so
// static `import` here throws "Cannot use import statement outside a module".
// Dynamic import() is allowed from a classic script, so the whole file is
// wrapped in an async IIFE that awaits the imports first; everything below
// stays unchanged and closes over these bindings normally.
(async () => {
const { cleanDocumentTitle, selectTitle, isSameOriginPageAnchor } = await import(chrome.runtime.getURL("lib/title.js"));
const { buildSnapshot, snapshotFingerprint } = await import(chrome.runtime.getURL("lib/normalize.js"));
const { sendEvidence, sendEvidenceFromCounts, samePrompt } = await import(chrome.runtime.getURL("lib/send-confirm.js"));
const { waitFor: waitForLib } = await import(chrome.runtime.getURL("lib/wait-for.js"));
const { pingBackground } = await import(chrome.runtime.getURL("lib/background-ping.js"));
const { captureViaApi, captureWithRecovery, AdaptivePacer, listAllConversations, listConversationsPage, selectChangedConversations, parseRemoteTime, getAccessToken, getConversationProjectId, fetchConversationTree, linearizeMapping, replyFromTree, resolveFileDownloadUrl, getSessionIdentity, imagesInMessages, listProjectChats, nextReplyCheckGapMs, REPLY_CHECK_MIN_GAP_MS } = await import(chrome.runtime.getURL("lib/api-capture.js"));

const DEFAULTS = {
  brokerUrl: "ws://localhost:8787/extension",
  token: "change-me",
  autoArchive: true,
  autoArchiveDelayMs: 3000,
  debug: false,
};

let socket;
let reconnectTimer;
let archiveTimer;
let lastSnapshotFingerprint = null;
let lastAutoDomKey = null;
let isCapturing = false;
let contextInvalidated = false;

// Auto-archive (MutationObserver -> scheduleArchive -> sendSnapshot) pushes
// thread_snapshot straight over the socket -- it never goes through the
// server's dispatchToExtension/agentPacer path at all, so none of that
// pacing or logging ever covered it, even though its own pre-existing code
// comment already documented one prior incident from page activity alone
// ("8 fetches for a two-message chat, 5 HTTP 429"). Found 2026-09-18 while
// investigating a rate-limit spike that coincided with heavy multi-tab
// ChatGPT use, not with any explicit ask_chatgpt call -- this is the missing
// piece. Reuses the same AdaptivePacer already proven for bulk-archive.
const AUTO_CAPTURE_PACER_STORAGE_KEY = "autoCaptureSpacingMs";
let autoCapturePacer = null;
let lastAutoCaptureAttemptAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -- status / observability --------------------------------------------------
// The popup and the broker never see raw console spam; they see this status
// object, persisted to chrome.storage.local so it survives content-script
// reloads (e.g. after `chrome://extensions` reload) even before a new capture.
const status = {
  connected: false,
  threadId: null,
  title: null,
  titleSource: null,
  url: null,
  lastArchiveAt: null,
  lastArchiveStatus: null, // 'ok' | 'error'
  lastArchiveError: null,
  captureSource: null, // 'api' | 'dom'
  completenessWarning: null,
};

async function debugEnabled() {
  try {
    const cfg = await chrome.storage.sync.get(DEFAULTS);
    return Boolean(cfg.debug);
  } catch {
    return false;
  }
}

async function log(level, message, extra) {
  if (!(await debugEnabled())) return;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`[conversation-manager] ${message}`, extra ?? "");
}

async function persistStatus() {
  try {
    await chrome.storage.local.set({ lastStatus: { ...status, savedAt: new Date().toISOString() } });
  } catch (err) {
    handlePossibleContextInvalidation(err);
  }
}

function setStatus(patch) {
  Object.assign(status, patch);
  persistStatus();
}

function handlePossibleContextInvalidation(err) {
  const message = String(err?.message || err || "");
  if (!message.includes("Extension context invalidated")) return false;
  if (contextInvalidated) return true;
  contextInvalidated = true;
  clearTimeout(reconnectTimer);
  clearTimeout(archiveTimer);
  try {
    observer.disconnect();
  } catch {}
  // Not an application failure: this happens whenever the unpacked extension is
  // reloaded while an old content script instance is still attached to a live
  // tab. The stale instance simply stops working until the tab is refreshed.
  console.info("[conversation-manager] Extension was reloaded; refresh this ChatGPT tab to reconnect.");
  return true;
}

// -- thread / title detection -------------------------------------------------

function currentThreadId() {
  // A conversation that already belongs to a project is served at
  // /g/<gizmo-id>/c/<thread-id>, not the plain /c/<thread-id> — match both.
  const m = location.pathname.match(/^\/c\/([^/?#]+)/) || location.pathname.match(/^\/g\/[^/]+\/c\/([^/?#]+)/);
  return m?.[1] || null;
}

// Finds a conversation's sidebar link by ID — works for any thread whose link
// is currently rendered in the sidebar, not just the one the page is open to.
function conversationLinkById(threadId) {
  if (!threadId) return null;
  const anchors = [...document.querySelectorAll("nav a[href], aside a[href]")];

  const candidates = anchors.filter((a) => {
    const raw = a.getAttribute("href") || "";
    if (isSameOriginPageAnchor(raw)) return false; // reject "Skip to content"-style anchors
    let u;
    try {
      u = new URL(a.href, location.href);
    } catch {
      return false;
    }
    if (u.origin !== location.origin) return false;
    return u.pathname.replace(/\/$/, "") === `/c/${threadId}`;
  });

  if (!candidates.length) return null;
  return candidates.find((a) => a.getAttribute("aria-current") === "page") || candidates[0];
}

function currentConversationLink() {
  return conversationLinkById(currentThreadId());
}

// After moving a conversation into a project, ChatGPT client-side-navigates
// the tab into that project's own scoped view (/g/g-p-.../project), whose
// sidebar only shows that project's conversations. A background-target
// operation for a different thread run from inside that scoped view will
// never find its target no matter how much it scrolls. Click the app's own
// "Home"/"New chat" link (an SPA navigation, not a full reload — a full
// reload would kill this very content-script instance mid-command) to get
// back to the general, unscoped conversation list before searching.
async function ensureGeneralSidebarContext() {
  if (!/^\/g\//.test(location.pathname)) return;
  const homeLink =
    document.querySelector('a[href="/"][aria-label="Home"]') ||
    document.querySelector('a[data-testid="create-new-chat-button"]') ||
    document.querySelector('a[href="/"]');
  if (!homeLink) return;
  homeLink.click();
  // The virtualized conversation list remounts after this SPA navigation and
  // is not guaranteed to have rendered any actual thread links yet — wait for
  // at least one instead of a fixed guess, so scrollSidebarUntilVisible's own
  // container-detection doesn't run against an empty sidebar and bail out
  // immediately.
  try {
    await waitFor(() => document.querySelector('nav a[href^="/c/"]'), 3000);
  } catch {
    /* fall through — scrollSidebarUntilVisible will bail out gracefully */
  }
}

// The sidebar conversation list is a virtualized/infinite-scroll list — a
// thread far down the history may not be rendered yet. Scrolls the sidebar's
// own scroll container in small steps, checking after each for the target
// link to appear, up to a bounded number of attempts.
async function scrollSidebarUntilVisible(threadId, maxAttempts = 80) {
  const anyLink = document.querySelector('nav a[href^="/c/"]');
  let container = anyLink;
  for (let depth = 0; container && depth < 8; depth++, container = container.parentElement) {
    if (container.scrollHeight > container.clientHeight + 40) break;
  }
  if (!container) return conversationLinkById(threadId);
  let stuckCount = 0;
  for (let i = 0; i < maxAttempts; i++) {
    const found = conversationLinkById(threadId);
    if (found) return found;
    const before = container.scrollTop;
    container.scrollTop += container.clientHeight;
    await sleep(300); // give the virtualized list time to actually render the next batch
    // Require several consecutive non-advancing scrolls before concluding we've
    // hit the real end — a single unchanged read can just mean content hadn't
    // finished loading yet, not that there's nothing more.
    stuckCount = container.scrollTop === before ? stuckCount + 1 : 0;
    if (stuckCount >= 3) break;
  }
  return conversationLinkById(threadId);
}

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
}
function normalizedText(el) {
  return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
}
// lib/wait-for.js: also checks once after the deadline, since a hidden tab's
// throttled timer can overshoot the whole window in one sleep.
function waitFor(predicate, timeout = 5000, interval = 80) {
  return waitForLib(predicate, timeout, interval);
}

// apiTitle (from the same-origin conversation-tree response, when available) is
// the most authoritative source: it is ChatGPT's own server-side title, not a
// DOM guess, so it sidesteps the whole "Skip to content" class of bug entirely.
function resolveTitle(apiTitle) {
  return selectTitle([
    { source: "api", value: apiTitle },
    { source: "sidebar-current", value: normalizedText(currentConversationLink()) },
    { source: "document-title", value: cleanDocumentTitle(document.title) },
    { source: "aria-current-nav", value: normalizedText(document.querySelector('nav a[aria-current="page"]')) },
    { source: "header-h1", value: normalizedText(document.querySelector("header h1")) },
    { source: "main-h1", value: normalizedText(document.querySelector("main h1")) },
  ]);
}

// -- DOM capture (fallback path) ----------------------------------------------

function inferRole(node) {
  const explicit = node.getAttribute?.("data-message-author-role");
  if (explicit) return explicit;
  const s = `${node.getAttribute?.("aria-label") || ""} ${node.className || ""}`.toLowerCase();
  if (/assistant/.test(s)) return "assistant";
  if (/user/.test(s)) return "user";
  return "unknown";
}

function findScrollContainer() {
  const anchor = document.querySelector('[data-message-author-role]') || document.querySelector("main");
  let node = anchor;
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight + 40) return node;
  }
  return null;
}

// Best-effort mitigation for virtualization when the API path is unavailable:
// scroll the conversation to the top a few times, giving lazy-mounted turns a
// chance to render, before scraping the DOM. This does not guarantee
// completeness (hence completenessWarning is still attached by the caller).
async function scrollToTopBestEffort() {
  const container = findScrollContainer();
  if (!container) return;
  let lastHeight = -1;
  for (let i = 0; i < 12; i++) {
    container.scrollTop = 0;
    await sleep(150);
    if (container.scrollHeight === lastHeight && container.scrollTop === 0) break;
    lastHeight = container.scrollHeight;
  }
}

function extractMessagesFromDom() {
  const selectors = ['[data-message-author-role]', "main article", 'main [data-testid^="conversation-turn"]'];
  let nodes = [];
  for (const sel of selectors) {
    nodes = [...document.querySelectorAll(sel)].filter(visible);
    if (nodes.length >= 2) break;
  }
  const seen = new Set();
  const messages = [];
  for (const node of nodes) {
    const container = node.closest("[data-message-author-role]") || node;
    const role = inferRole(container);
    const messageId = container.getAttribute?.("data-message-id") || container.id || null;
    const text = normalizedText(container);
    if (!text) continue;
    const key = `${role}:${messageId || text.slice(0, 160)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push({ message_id: messageId, role, text });
  }
  return messages;
}

// -- snapshot capture ----------------------------------------------------------

// Returns { snapshot, apiErrorStatus, apiErrorRetryAfterMs } rather than just
// the snapshot: the real HTTP status/Retry-After from a failed API capture is
// swallowed into a DOM fallback below (by design, so one failed endpoint
// never blocks archiving), but callers pacing/logging against the real
// backend signal (mirrors getReply's api_status/api_retry_after_ms) still
// need it -- it must not leak into the archived snapshot's own schema.
async function captureSnapshot() {
  const threadId = currentThreadId();
  if (!threadId) throw new Error("Open a normal ChatGPT conversation (/c/…) before capturing.");

  let apiResult = null;
  let apiError = null;
  try {
    apiResult = await captureViaApi(threadId);
  } catch (err) {
    apiError = err;
    await log("warn", `same-origin API capture failed, falling back to DOM: ${err.message}`);
  }
  const apiErrorStatus = apiError?.status ?? null;
  const apiErrorRetryAfterMs = apiError?.retryAfterMs ?? null;

  if (apiResult && apiResult.messages.length) {
    const { title, source } = resolveTitle(apiResult.title);
    return { snapshot: buildSnapshot({
      threadId,
      title,
      titleSource: source,
      url: location.href,
      messages: apiResult.messages,
      captureSource: "api",
      completenessWarning: null,
    }), apiErrorStatus: null, apiErrorRetryAfterMs: null };
  }

  await scrollToTopBestEffort();
  const domMessages = extractMessagesFromDom();
  // A zero-message DOM scrape is not "an empty conversation" — on the pages
  // this tool ever navigates to, it means the current page isn't actually a
  // conversation at all (e.g. still on a project's landing page right after
  // an API failure/rate-limit interrupted the expected navigation). Silently
  // archiving that would overwrite a real prior snapshot's message history
  // with nothing — observed live, not hypothetical. Refuse instead.
  if (!domMessages.length) {
    throw new Error(
      apiError
        ? `API capture failed (${apiError.message}) and DOM scraping found no messages on this page — refusing to overwrite the archive with an empty capture.`
        : "DOM scraping found no messages on this page — refusing to overwrite the archive with an empty capture."
    );
  }
  const { title, source } = resolveTitle(null);
  return { snapshot: buildSnapshot({
    threadId,
    title,
    titleSource: source,
    url: location.href,
    messages: domMessages,
    captureSource: "dom",
    completenessWarning: apiError
      ? `Same-origin API capture unavailable (${apiError.message}); used DOM scraping, which cannot guarantee complete history on long/virtualized conversations.`
      : null,
  }), apiErrorStatus, apiErrorRetryAfterMs };
}

async function sendSnapshot(force = false) {
  if (contextInvalidated) {
    if (force) throw new Error("Extension was reloaded; refresh this ChatGPT tab to reconnect before capturing.");
    return null;
  }
  if (!currentThreadId()) {
    if (force) throw new Error("Open a normal ChatGPT conversation (/c/…) before capturing.");
    return null;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (force) throw new Error("Not connected to the broker (is the backend running and is the token correct?).");
    return null;
  }
  if (isCapturing) {
    if (force) throw new Error("A capture is already in progress; try again in a moment.");
    return null;
  }
  // Automatic captures fetch the conversation from ChatGPT's API, which shares
  // one per-account request limit with ChatGPT's own page and with bulk
  // archiving. Page activity alone was firing several fetches per new chat
  // (observed: 8 for a two-message chat, 5 of them HTTP 429), so skip when the
  // chat has no real id yet, is still generating, or looks unchanged.
  let domKey = null;
  const threadIdForLog = currentThreadId();
  if (!force) {
    if (currentThreadId().startsWith("WEB:")) return null;
    if (findFirst(STOP_BUTTON_SELECTORS, visible)) return null;
    const messages = extractMessagesFromDom();
    const last = messages[messages.length - 1];
    domKey = `${currentThreadId()}|${messages.length}|${last?.role}|${(last?.text || "").length}`;
    if (domKey === lastAutoDomKey) { reportDomActivity(threadIdForLog, domKey, "skipped_dedup"); return null; }
    // Independent of the server's agentPacer (this push never goes through
    // dispatchToExtension at all): a local minimum gap so a burst of DOM
    // mutations -- Brian actively chatting, several tabs at once -- can't
    // uncontrollably hit the same conversation-tree endpoint the pacer above
    // exists to protect.
    const pacer = await loadAutoCapturePacer();
    if (Date.now() - lastAutoCaptureAttemptAt < pacer.spacingMs) {
      reportDomActivity(threadIdForLog, domKey, "skipped_throttled");
      return null;
    }
  }
  reportDomActivity(threadIdForLog, domKey, force ? "forced" : "attempted");
  isCapturing = true;
  if (!force) lastAutoCaptureAttemptAt = Date.now();
  try {
    const { snapshot, apiErrorStatus, apiErrorRetryAfterMs } = await captureSnapshot();
    if (domKey) lastAutoDomKey = domKey;
    if (!force) {
      if (apiErrorStatus === 429) { applyAutoCaptureRateLimit(apiErrorRetryAfterMs); await saveAutoCapturePacer(); }
      else if (autoCapturePacer) { autoCapturePacer.onSuccess(); await saveAutoCapturePacer(); }
    }
    const fp = snapshotFingerprint(snapshot);
    if (!force && fp === lastSnapshotFingerprint) return snapshot;
    lastSnapshotFingerprint = fp;
    socket.send(JSON.stringify({ type: "thread_snapshot", snapshot, api_error_status: apiErrorStatus }));
    setStatus({
      threadId: snapshot.thread_id,
      title: snapshot.title,
      titleSource: snapshot.title_source,
      url: snapshot.url,
      captureSource: snapshot.capture_source,
      completenessWarning: snapshot.completeness_warning,
    });
    return snapshot;
  } catch (err) {
    setStatus({ lastArchiveStatus: "error", lastArchiveError: err.message });
    await log("error", "capture failed", err);
    throw err;
  } finally {
    isCapturing = false;
  }
}

function scheduleArchive() {
  if (contextInvalidated) return;
  clearTimeout(archiveTimer);
  let pending;
  try {
    // In a stale instance (extension reloaded under a live tab) this throws
    // synchronously rather than rejecting, so .catch alone does not see it.
    pending = chrome.storage.sync.get(DEFAULTS);
  } catch (err) {
    if (handlePossibleContextInvalidation(err)) return;
    throw err;
  }
  pending
    .then((cfg) => {
      if (!cfg.autoArchive || !currentThreadId()) return;
      archiveTimer = setTimeout(() => {
        sendSnapshot(false).catch(() => {});
      }, Number(cfg.autoArchiveDelayMs) || 3000);
    })
    .catch((err) => handlePossibleContextInvalidation(err));
}

// -- visible-UI rename ---------------------------------------------------------

function findMenuButtonNear(link) {
  let node = link;
  for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
    const buttons = [...node.querySelectorAll("button")].filter(visible);
    const labeled = buttons.find((b) => /menu|more|options/i.test(`${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""}`));
    if (labeled) return labeled;
    if (buttons.length === 1) return buttons[0];
  }
  return null;
}
function findRenameMenuItem() {
  return [...document.querySelectorAll('[role="menuitem"], button, [role="button"]')]
    .filter(visible)
    .find((el) => /^rename$/i.test(normalizedText(el)) || /rename/i.test(`${el.getAttribute("aria-label") || ""} ${normalizedText(el)}`));
}
function findRenameInput() {
  const inputs = [...document.querySelectorAll('input[type="text"], input:not([type]), textarea')].filter(visible);
  return inputs.find((i) => /rename|title|conversation/i.test(`${i.getAttribute("aria-label") || ""} ${i.getAttribute("placeholder") || ""}`)) || inputs.at(-1);
}
function setNativeValue(input, value) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter ? setter.call(input, value) : (input.value = value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function renameViaVisibleUi(title, targetThreadId) {
  const isBackgroundTarget = Boolean(targetThreadId) && targetThreadId !== currentThreadId();
  if (!isBackgroundTarget && !currentThreadId()) throw new Error("Open a normal ChatGPT conversation (/c/…) before renaming.");
  if (isBackgroundTarget) await ensureGeneralSidebarContext();
  let link, menuButton, menuItem, input;
  try {
    link = isBackgroundTarget ? await scrollSidebarUntilVisible(targetThreadId) : await waitFor(currentConversationLink, 4000);
    if (!link) throw new Error("not found");
  } catch {
    throw new Error(isBackgroundTarget ? `Could not find thread ${targetThreadId} in the sidebar (it may need more scrolling, or the UI changed).` : "Could not find the current conversation's sidebar entry to rename.");
  }
  link.scrollIntoView({ block: "nearest" });
  link.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  await sleep(150);
  try {
    menuButton = await waitFor(() => findMenuButtonNear(link), 2500);
  } catch {
    throw new Error("Could not find the conversation's menu button (ChatGPT UI may have changed).");
  }
  menuButton.click();
  try {
    menuItem = await waitFor(findRenameMenuItem, 3000);
  } catch {
    throw new Error("Could not find a 'Rename' menu item (ChatGPT UI may have changed).");
  }
  menuItem.click();
  try {
    input = await waitFor(findRenameInput, 3000);
  } catch {
    throw new Error("Could not find the rename text input (ChatGPT UI may have changed).");
  }
  input.focus();
  setNativeValue(input, title);
  const dialog = input.closest('[role="dialog"]') || input.parentElement?.parentElement;
  const buttons = [...(dialog || document).querySelectorAll("button")].filter(visible);
  const save = buttons.find((b) => /^(save|rename|confirm)$/i.test(normalizedText(b))) || buttons.find((b) => /save|rename/i.test(normalizedText(b)));
  if (save) save.click();
  else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  await sleep(500);

  const resolved = isBackgroundTarget ? normalizedText(conversationLinkById(targetThreadId)) : resolveTitle(null).title;
  if (!isBackgroundTarget) scheduleArchive();
  if (!resolved || resolved.toLowerCase() !== title.toLowerCase()) {
    throw new Error(`Rename was submitted but the visible title now reads "${resolved || "(undetected)"}" instead of "${title}". Verify manually — automation ran but success is not confirmed.`);
  }
  return resolved;
}

// -- move to native ChatGPT project ---------------------------------------------
// Mirrors an archive-side project assignment into ChatGPT's own Projects
// feature. Uses the same "..." menu as rename, but a different submenu:
// Move to project -> either click an existing project name, or "New project"
// (opens a name+create dialog) which both creates the project and moves this
// conversation into it in one step.

function findMoveToProjectMenuItem() {
  return [...document.querySelectorAll('[role="menuitem"], button, [role="button"]')]
    .filter(visible)
    .find((el) => /move to project/i.test(normalizedText(el)));
}
// The sidebar's real Projects list can contain an entry with the exact same
// text as the submenu item we want (e.g. both say "Quick Lookups & Trivia") —
// an unscoped document-wide search can match the sidebar link instead of the
// actual submenu item. Scope the search to the submenu's own container,
// anchored on "New project" (unique, always present, easy to find reliably).
function findProjectSubmenuContainer() {
  const newProjectEl = [...document.querySelectorAll('[role="menuitem"], button, [role="button"]')].filter(visible).find((el) => /^new project$/i.test(normalizedText(el)));
  if (!newProjectEl) return null;
  let node = newProjectEl;
  for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
    if (node.querySelectorAll('[role="menuitem"], button, [role="button"]').length > 1) return node;
  }
  return newProjectEl.parentElement;
}
function findProjectSubmenuItem(projectName) {
  const container = findProjectSubmenuContainer();
  if (!container) return null;
  const target = projectName.trim().toLowerCase();
  return [...container.querySelectorAll('[role="menuitem"], button, [role="button"]')].filter(visible).find((el) => normalizedText(el).toLowerCase() === target);
}
function findNewProjectMenuItem() {
  return [...document.querySelectorAll('[role="menuitem"], button, [role="button"]')].filter(visible).find((el) => /^new project$/i.test(normalizedText(el)));
}
function findCreateProjectNameInput() {
  const inputs = [...document.querySelectorAll('input[type="text"], input:not([type]), textarea')].filter(visible);
  return inputs.find((i) => /project name/i.test(`${i.getAttribute("aria-label") || ""} ${i.getAttribute("placeholder") || ""}`)) || inputs.at(-1);
}
function findCreateProjectButton() {
  return [...document.querySelectorAll("button")].filter(visible).find((b) => /^create project$/i.test(normalizedText(b)));
}

// The sidebar's "Chats" list only ever renders a fixed recent batch (~28) and
// does not paginate further on scroll, on a genuine trusted scroll-wheel
// event, or after a hard cache-busting reload — verified live, not assumed.
// Any thread outside that batch can never be found by hovering a sidebar row.
// The open conversation's own header has an independent "..." menu
// (data-testid="conversation-options-button") offering the identical Rename /
// Move to project / Archive actions, and it exists on every conversation page
// regardless of sidebar visibility. Requiring the caller (server-orchestrated
// via a prior navigate_to_thread command) to already be on the target
// thread's page and driving this header menu instead makes every thread
// reachable, not just the visible recent ones.
function findConversationOptionsButton() {
  return document.querySelector('[data-testid="conversation-options-button"]');
}

async function moveToProjectViaVisibleUi(projectName, targetThreadId) {
  const threadId = targetThreadId || currentThreadId();
  if (!threadId) throw new Error("Open a normal ChatGPT conversation (/c/…) before moving it to a project.");
  if (currentThreadId() !== threadId) {
    throw new Error(`Not currently on thread ${threadId} (send navigate_to_thread first, then retry once the extension reports it as current).`);
  }

  const beforeId = await getConversationProjectId(threadId).catch(() => null);

  let menuButton;
  try {
    menuButton = await waitFor(findConversationOptionsButton, 4000);
  } catch {
    throw new Error("Could not find the conversation's header menu button (ChatGPT UI may have changed).");
  }
  menuButton.click();

  let moveItem;
  try {
    moveItem = await waitFor(findMoveToProjectMenuItem, 3000);
  } catch {
    throw new Error("Could not find 'Move to project' menu item (ChatGPT UI may have changed).");
  }
  moveItem.click();
  await sleep(250);

  let existingItem = null;
  try {
    existingItem = await waitFor(() => findProjectSubmenuItem(projectName), 1200);
  } catch {
    /* not an existing project — fall through to create it */
  }

  if (existingItem) {
    existingItem.click();
    await sleep(500);
  } else {
    let newProjectItem;
    try {
      newProjectItem = await waitFor(findNewProjectMenuItem, 4000);
    } catch {
      throw new Error("Could not find 'New project' option (ChatGPT UI may have changed).");
    }
    newProjectItem.click();

    // The create-project dialog mounts with its own animation; under real
    // extension dispatch timing this reliably takes longer than the naive
    // 2000ms budget that worked fine when driven manually, so give it more room.
    let input;
    try {
      input = await waitFor(findCreateProjectNameInput, 4000);
    } catch {
      throw new Error("Could not find the project name input (ChatGPT UI may have changed).");
    }
    input.focus();
    setNativeValue(input, projectName);
    await sleep(250);

    let createBtn;
    try {
      createBtn = await waitFor(findCreateProjectButton, 4000);
    } catch {
      throw new Error("Could not find the 'Create project' button (ChatGPT UI may have changed).");
    }
    createBtn.click();
    await sleep(800);
  }

  const afterId = await getConversationProjectId(threadId).catch(() => null);
  if (!afterId || afterId === beforeId) {
    throw new Error(`Move to project was submitted but the conversation's project membership did not change (before=${beforeId || "none"}, after=${afterId || "none"}). Verify manually — automation ran but success is not confirmed.`);
  }
  return { project: projectName, project_ref: afterId };
}

// -- bulk archive ---------------------------------------------------------------
// Archives every conversation in the account, not just the one currently open.
// Works entirely through the same-origin API — no need to open each thread in a
// tab. Runs in the background and reports progress over the WS (the broker's
// 15s command-result timeout is too short to wait on synchronously for a job
// that may cover hundreds of conversations).

let bulkArchiving = false;
const CAPABILITIES = { incremental_archive: true, rate_limit_recovery: true, adaptive_pacing: true, ask: true, agent_tab: true, list_chats: true };

// A tab keeps one token across full-page navigations (sessionStorage is per tab
// and per origin), so the broker can address THIS tab again after it navigates
// and reconnects. Without it, a command meant for one tab reaches every tab.
let TAB_TOKEN = (() => {
  try {
    let t = sessionStorage.getItem("ccm_tab_token");
    if (!t) { t = crypto.randomUUID(); sessionStorage.setItem("ccm_tab_token", t); }
    return t;
  } catch { return crypto.randomUUID(); }
})();

// A tab opened at https://chatgpt.com/?ccm_agent=1 is the agents' tab for the rest
// of its life (sessionStorage survives its navigations). ask_chatgpt only types
// there, so agents never touch a tab Brian is using.
const AGENT_TAB = (() => {
  try {
    if (new URL(location.href).searchParams.get("ccm_agent") === "1") sessionStorage.setItem("ccm_agent_tab", "1");
    return sessionStorage.getItem("ccm_agent_tab") === "1";
  } catch { return false; }
})();

// Whether this tab's browser context is a private/incognito window. Requires
// the user to have flipped "Allow in Incognito" for this extension; without
// that toggle, the content script never runs there at all and this is moot.
const INCOGNITO = Boolean(chrome.extension && chrome.extension.inIncognitoContext);

// Unlike TAB_TOKEN, new for every page load: lets the broker tell a reloaded
// page from the one it replaced (both report the same tab and thread id).
const PAGE_ID = crypto.randomUUID();
const PAGE_STARTED_AT = Date.now();

function showAgentTabBadge() {
  if (!AGENT_TAB || document.getElementById("ccm-agent-badge")) return;
  const badge = document.createElement("div");
  badge.id = "ccm-agent-badge";
  badge.textContent = "Agent tab — Claude Code / Codex type here";
  badge.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:4px 8px;border-radius:6px;background:#b45309;color:#fff;font:12px system-ui;pointer-events:none;opacity:.9";
  (document.body || document.documentElement).appendChild(badge);
}
showAgentTabBadge();

// ask_chatgpt ------------------------------------------------------------------

// Ordered most-specific first. ChatGPT's 2026-09 Home layout dropped the
// #prompt-textarea id, so generic editor fallbacks follow the known ids; each is
// still gated by visible() and must accept text, so a stray hidden editor cannot
// be picked. debug_inspect_toolbar now lists every editable it can see, so the
// next layout change can be diagnosed from a live tab instead of guessed.
const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  'div[contenteditable="true"][id*="prompt"]',
  "form textarea",
  '[data-testid*="composer"] [contenteditable="true"]',
  'div.ProseMirror[contenteditable="true"]',
  'main [contenteditable="true"][data-placeholder]',
  'main div[contenteditable="true"][role="textbox"]',
  "main textarea",
];
const SEND_BUTTON_SELECTORS = ['[data-testid="send-button"]', 'button[aria-label*="Send"]'];

function findFirst(selectors, accept = () => true) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && accept(el)) return { el, selector: sel };
  }
  return null;
}

function refuseWhileArchiving(action) {
  if (bulkArchiving) throw new Error(`busy: a bulk archive is running in this tab, so ${action} would stop it; use another ChatGPT tab.`);
}

async function sendPrompt(text, excludeThreads = []) {
  refuseWhileArchiving("sending a prompt");
  const body = String(text || "");
  if (!body.trim()) throw new Error("text is required.");
  // Failing here is before anything is typed, fetched, or clicked, and the
  // error says so (nothing_sent) along with which page instance it was, so
  // the broker can safely reload this tab and send once more. The page facts
  // are what the 2026-09-27 failures lacked: those pages had been loaded ~2
  // minutes, so "the layout may have changed" was not the explanation.
  const composer = await waitFor(() => findFirst(COMPOSER_SELECTORS, visible), 15000)
    .catch((waitErr) => {
      const banner = visibleRateLimitError();
      const page = `page ${location.pathname} loaded ${Math.round((Date.now() - PAGE_STARTED_AT) / 1000)}s ago, `
        + `${document.visibilityState}, ${extractMessagesFromDom().length} messages rendered, `
        + `rate-limit banner ${banner ? "showing" : "not showing"}, `
        + `checked ${waitErr.checks ?? "?"} times over ${Math.round((waitErr.waited_ms ?? 0) / 1000)}s`;
      throw Object.assign(
        new Error(`no ChatGPT composer found (tried ${COMPOSER_SELECTORS.join(", ")}) within 15s (${page}); nothing was typed or sent.`),
        { reply: { stage: "no_composer", nothing_sent: true, page_id: PAGE_ID, visible_error: banner } },
      );
    });
  const threadBefore = realThreadId();
  // Counted on the page, not through the conversation API: that endpoint is
  // rate-limited for the whole account (HTTP 429) whenever archiving has run.
  const domBefore = extractMessagesFromDom().length;
  // For a continued conversation the DOM may be virtualized (a hidden tab
  // mounts 0 messages), so only the conversation tree's message count marks
  // where our reply starts. Without it there is no safe boundary: a 0
  // baseline returned every earlier answer as "the reply" (2026-09-27,
  // extension 0.7.2), and locating our turn by prompt text cannot tell it
  // from an earlier turn of a templated prompt (the audit's prompts share
  // 117+ leading characters). So a continuation is not sent without it; the
  // error says nothing was sent, and the broker retries once after its
  // rate-limit gap (server/index.js askChatgpt).
  let messagesBefore = domBefore;
  if (threadBefore) {
    try {
      messagesBefore = linearizeMapping(await fetchConversationTree(threadBefore)).length;
    } catch (err) {
      throw Object.assign(
        new Error(`could not read conversation ${threadBefore} before sending (${err.message}), so its reply could not be told apart from earlier ones; nothing was typed or sent.`),
        { reply: { stage: "no_baseline", nothing_sent: true, page_id: PAGE_ID, api_status: err.status ?? null, api_retry_after_ms: err.retryAfterMs ?? null } },
      );
    }
  }
  // The composer is always emptied first and then must hold exactly our
  // prompt (whitespace-normalized) before Send is clicked. It used to skip
  // typing when the composer already "included" the prompt's first 40
  // characters -- and a failed or unaccepted earlier send leaves its text in
  // the composer. Audit prompts share long templated heads, so the next ask
  // skipped typing and clicked Send on the previous ask's text: all 28
  // misattributed replies on 2026-09-27/28 were exactly this (see
  // CHANGELOG v0.8.0). Right after a navigation the editor can also drop the
  // first insert, so this retries for a few seconds.
  let el = composer.el;
  const composerText = () => el.value ?? el.innerText ?? "";
  const typedOk = await waitFor(() => {
    el = findFirst(COMPOSER_SELECTORS, visible)?.el || el;
    if (samePrompt(composerText(), body)) return true;
    setComposerText(el, body);
    return samePrompt(composerText(), body) ? true : null;
  }, 8000, 400).catch(() => false);
  if (!typedOk) {
    const heldChars = composerText().length;
    clearComposer(el);
    throw Object.assign(
      new Error(`the composer did not end up holding exactly this prompt after retrying for 8s (it held ${heldChars} characters, the prompt has ${body.length}); the composer was cleared and nothing was sent.`),
      { reply: { stage: "not_typed", nothing_sent: true, page_id: PAGE_ID } },
    );
  }
  const button = await waitFor(() => findFirst(SEND_BUTTON_SELECTORS, (b) => visible(b) && !b.disabled), 8000)
    .catch(() => null);
  if (!button) {
    // Leaving the text behind is what let a later ask send it by accident.
    clearComposer(el);
    throw Object.assign(
      new Error(`no enabled send button found within 8s (tried ${SEND_BUTTON_SELECTORS.join(", ")}; prompt ${body.length} characters); the composer was cleared and nothing was sent.`),
      { reply: { stage: "no_send_button", nothing_sent: true, page_id: PAGE_ID } },
    );
  }
  const threadRawBefore = currentThreadId();
  const pageEvidence = () => sendEvidence({
    composerText: composerText(),
    threadRawBefore, threadRawNow: currentThreadId(),
    domBefore, domMessages: extractMessagesFromDom(), expected: body,
  });
  // Server-side truth when the page shows nothing (hidden tabs are throttled
  // and may not re-render): a continuation's message count grew, or a new
  // chat containing exactly this prompt exists among the newest chats.
  const serverEvidence = async () => {
    try {
      if (threadBefore) {
        const by = sendEvidenceFromCounts(linearizeMapping(await fetchConversationTree(threadBefore)).length, messagesBefore);
        return by ? { by, thread_id: threadBefore } : null;
      }
      const id = await findNewChatWithPrompt(body, excludeThreads);
      return id ? { by: "server_new_chat", thread_id: id } : null;
    } catch (err) {
      await log("warn", "Could not check ChatGPT's server for the sent prompt", err);
      return { error: err.message };
    }
  };
  button.el.click();
  // After the click the prompt may already be with ChatGPT, so from here on a
  // missing confirmation is "unconfirmed", never "not sent". A hidden tab's
  // composer often does not clear in time even though the send landed
  // (lib/send-confirm.js has the evidence).
  let confirmedBy = await waitFor(pageEvidence, 10000, 250).catch(() => null);
  let serverThreadId = null;
  let serverCheckError = null;
  if (!confirmedBy) {
    const server = await serverEvidence();
    if (server?.by) { confirmedBy = server.by; serverThreadId = server.thread_id; }
    else if (server?.error) serverCheckError = server.error;
  }
  // Not confirmed yet: the prompt stays in the composer untouched, and the
  // broker keeps watching. getReply looks for the new chat server-side, and
  // the broker may ask for another click (retrySendClick) once the server
  // has shown for a while that nothing arrived. The next ask cannot send the
  // leftover text by accident: every ask empties the composer first.
  // A new chat first shows a temporary id ("WEB:<uuid>") in the URL and swaps in
  // the real conversation id once the server has created it.
  const threadId = threadBefore || serverThreadId || (confirmedBy ? await waitFor(() => realThreadId(), 60000, 250).catch(() => null) : realThreadId());
  return { thread_id: threadId, dom_before: domBefore, messages_before: messagesBefore,
           send_confirmed: Boolean(confirmedBy), confirmed_by: confirmedBy,
           server_check_error: serverCheckError,
           visibility: document.visibilityState, has_focus: document.hasFocus(),
           composer_selector: composer.selector, send_selector: button.selector };
}

// Click Send again for an ask whose earlier click showed no effect -- but
// only after ChatGPT's server confirms the prompt has not arrived, and only
// if the composer still holds exactly that prompt and ChatGPT is not
// generating. Evidence (2026-09-27/28 audit): a click on a very large prompt
// in a hidden tab was dropped, not queued. In 26 cases the prompt stayed
// unsent for up to 15 minutes, until a later click sent it exactly once.
async function retrySendClick(expected, threadBefore, messagesBefore, excludeThreads = []) {
  if (threadBefore) {
    const count = linearizeMapping(await fetchConversationTree(threadBefore)).length;
    if (sendEvidenceFromCounts(count, messagesBefore)) return { clicked: false, confirmed_by: "server_turn", thread_id: threadBefore };
  } else {
    const id = await findNewChatWithPrompt(expected, excludeThreads);
    if (id) return { clicked: false, confirmed_by: "server_new_chat", thread_id: id };
    if (realThreadId()) return { clicked: false, reason: "page_has_conversation", thread_id: realThreadId() };
  }
  if (findFirst(STOP_BUTTON_SELECTORS, visible)) return { clicked: false, reason: "generating" };
  const composer = findFirst(COMPOSER_SELECTORS, visible);
  if (!composer || !samePrompt(composer.el.value ?? composer.el.innerText ?? "", expected)) return { clicked: false, reason: "composer_no_longer_holds_prompt" };
  const button = findFirst(SEND_BUTTON_SELECTORS, (b) => visible(b) && !b.disabled);
  if (!button) return { clicked: false, reason: "no_enabled_send_button" };
  button.el.click();
  return { clicked: true, visibility: document.visibilityState };
}

function setComposerText(el, text) {
  el.focus();
  if (el.tagName === "TEXTAREA") {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false, null);
    if (text) document.execCommand("insertText", false, text);
    else document.execCommand("delete", false, null);
  }
}

function clearComposer(el) {
  try { setComposerText(el, ""); } catch (err) { log("warn", "Could not clear the composer", err); }
}

// Newest chats first; a chat counts only if its first user message is exactly
// this prompt and the broker has not already given it to another ask
// (excludeThreads). Chats not updated in the last 15 minutes (browser clock,
// so generous) are skipped without reading them. An identical prompt sent
// earlier in that window whose chat nobody claimed can match; its answer is
// then an answer to the identical text.
async function findNewChatWithPrompt(body, excludeThreads = []) {
  const skip = new Set(excludeThreads);
  const page = await listConversationsPage({ offset: 0, limit: 5 });
  for (const c of page.items || []) {
    if (skip.has(c.id)) continue;
    const updated = parseRemoteTime(c.update_time);
    if (updated != null && Date.now() - updated > 15 * 60000) continue;
    const firstUser = linearizeMapping(await fetchConversationTree(c.id)).find((m) => m.role === "user");
    if (firstUser && samePrompt(firstUser.text, body)) return c.id;
  }
  return null;
}

function realThreadId() {
  const t = currentThreadId();
  return t && !t.startsWith("WEB:") ? t : null;
}

const STOP_BUTTON_SELECTORS = ['[data-testid="stop-button"]', 'button[aria-label*="Stop"]'];
const RATE_LIMIT_SELECTORS = ['[role="alert"]', '[data-testid*="error"]', '[class*="error"]'];

// Real banner text observed 2026-09-17: "You're making requests too
// quickly. We've temporarily limited access to your conversations to
// protect your data." The old pattern only matched a generic "too many
// requests" phrase and would not have matched this actual wording.
const RATE_LIMIT_BANNER_TEXT = /too many requests|making requests too quickly|temporarily limited access to your conversations/i;

function visibleRateLimitError() {
  for (const selector of RATE_LIMIT_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      if (visible(el) && RATE_LIMIT_BANNER_TEXT.test(el.innerText || el.textContent || '')) return 'too_many_requests';
    }
  }
  return null;
}

// Fetches a resolved image URL in-page (so it always carries whatever auth the
// URL actually needs, same-origin or not) and returns it as inline base64 --
// the only shape that survives the trip through the WebSocket -> Node broker
// -> MCP content block, since none of those hops can dereference a ChatGPT
// tab-scoped URL themselves.
async function fetchImageAsDataParts(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const mimeType = res.headers.get("content-type") || "image/png";
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { data: btoa(binary), mimeType };
}

// replyFromTree only hands back raw asset-pointer metadata (a pure function,
// no network calls -- see its own comment). This is the async step that turns
// each pointer into actual bytes. One image failing to resolve must not lose
// the rest of the reply, so each is attempted independently and a failure is
// logged and dropped rather than thrown.
async function resolveReplyImages(images) {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const resolved = [];
  for (const img of images) {
    try {
      const downloadUrl = await resolveFileDownloadUrl(img.asset_pointer);
      const parts = await fetchImageAsDataParts(downloadUrl);
      resolved.push({ ...parts, name: img.name || null });
    } catch (err) {
      await log("warn", "Could not resolve a generated image; returning the rest of the reply without it", err);
    }
  }
  return resolved.length ? resolved : undefined;
}

// Read the reply from the page. Done when ChatGPT is no longer generating, and a
// new assistant message follows our own. The caller requires the same text on
// two done reads with no "not finished" read between them (reads that learn
// nothing, like a skipped or throttled API check, do not count), unless the
// backend marks the reply end_turn -- so a pause mid-stream is not "done".
async function getReply(domBefore, messagesBefore = domBefore, expected = null, excludeThreads = [], threadHint = null) {
  const generating = Boolean(findFirst(STOP_BUTTON_SELECTORS, visible));
  const messages = extractMessagesFromDom();
  const added = messages.slice(Number(domBefore) || 0);
  const last = messages[messages.length - 1];
  const replies = added.filter((m) => m.role === "assistant");
  const done = !generating && replies.length > 0 && last?.role === "assistant";
  // threadHint: a conversation the broker already located for this ask (a
  // server-side discovery) while this page still shows no id.
  const threadId = realThreadId() || threadHint || null;
  // Tool-heavy/reasoning chats can leave the mounted DOM with only the user
  // messages even after the authoritative conversation tree contains the
  // completed assistant answer. When generation is not visibly active, check
  // that tree regardless of the DOM-derived `done` flag. Throttle the private
  // API read so long tool runs do not poll it every three seconds, and back
  // it off while the account is throttled (nextReplyCheckGapMs).
  const shouldCheckApi = !generating && threadId && Date.now() - getReply.lastApiCheckAt >= getReply.apiGapMs;
  // Whether this call actually hit ChatGPT's backend, and with what result --
  // an HTTP status/Retry-After from a real failed fetch is a far more
  // reliable rate-limit signal than scraping a DOM banner for wording that
  // can change, and lets the broker's pacer react to the account's own
  // stated Retry-After instead of a guessed backoff.
  let apiStatus = null;
  let apiRetryAfterMs = null;
  if (shouldCheckApi) {
    getReply.lastApiCheckAt = Date.now();
    try {
      const apiReply = replyFromTree(await fetchConversationTree(threadId), messagesBefore == null ? null : (Number(messagesBefore) || 0), { expected });
      getReply.apiGapMs = REPLY_CHECK_MIN_GAP_MS;
      if (apiReply.status === "prompt_mismatch") {
        // The conversation's new turn is not our prompt: never wait for (or
        // return) its answer.
        return { done: false, generating, thread_id: threadId, message_count: messages.length, reply: null,
                 visible_error: visibleRateLimitError(), source: "api", prompt_mismatch: true,
                 found_prompt_head: apiReply.found_prompt_head, found_prompt_chars: apiReply.found_prompt_chars,
                 api_checked: true, api_status: 200, api_retry_after_ms: null };
      }
      if (apiReply.done) {
        const images = await resolveReplyImages(apiReply.images);
        return { ...apiReply, images, generating: false, thread_id: threadId,
                 visible_error: visibleRateLimitError(), source: "api",
                 api_checked: true, api_status: 200, api_retry_after_ms: null };
      }
    } catch (err) {
      apiStatus = err.status ?? null;
      apiRetryAfterMs = err.retryAfterMs ?? null;
      getReply.apiGapMs = nextReplyCheckGapMs(getReply.apiGapMs, { status: apiStatus, retryAfterMs: apiRetryAfterMs });
      await log("warn", "Could not read the completed reply from the conversation API; waiting instead of trusting virtualized DOM text", err);
    }
  }
  // Once ChatGPT has assigned a real conversation id, its conversation tree is
  // the only trustworthy completion boundary. Long/tool-heavy threads can
  // virtualize or remount the DOM, so slicing mounted messages by the pre-send
  // count can return a previous answer, a partial heading, or follow-up
  // suggestion chips as a false success. Keep polling the tree when it is
  // temporarily unavailable (for example during a 429) rather than accepting
  // an ambiguous DOM reply.
  if (threadId) {
    return { done: false, generating, thread_id: threadId, message_count: messages.length,
             reply: null, visible_error: visibleRateLimitError(), source: "api_waiting",
             api_checked: shouldCheckApi, api_status: apiStatus, api_retry_after_ms: apiRetryAfterMs };
  }
  // No conversation id on the page yet (a hidden tab may not re-render after
  // an unconfirmed send): look for the new chat on ChatGPT's server, at most
  // every 30s, so a landed send is still found and followed.
  if (expected && !done && Date.now() - getReply.lastDiscoveryAt >= 30000) {
    getReply.lastDiscoveryAt = Date.now();
    try {
      const found = await findNewChatWithPrompt(expected, excludeThreads);
      if (found) return { done: false, generating, thread_id: found, discovered_thread_id: found, message_count: messages.length,
                          reply: null, visible_error: visibleRateLimitError(), source: "server_discovery",
                          api_checked: true, api_status: 200, api_retry_after_ms: null };
    } catch (err) { await log("warn", "Could not look for the new chat on ChatGPT's server", err); }
  }
  // No conversation id yet: the page is the only source. Accept its answer
  // only when the new user turn on the page is exactly our prompt (a long
  // prompt rendered collapsed simply waits for the conversation tree).
  const ourTurn = !expected || added.some((m) => m.role === "user" && samePrompt(m.text, expected));
  const domDone = done && ourTurn;
  return { done: domDone, generating, thread_id: realThreadId(), message_count: messages.length,
           reply: domDone ? replies.map((m) => m.text).join("\n\n") : null, visible_error: visibleRateLimitError(), source: "dom",
           api_checked: false, api_status: null, api_retry_after_ms: null };
}
getReply.lastApiCheckAt = 0;
getReply.lastDiscoveryAt = 0;
getReply.apiGapMs = REPLY_CHECK_MIN_GAP_MS;

const PACER_STORAGE_KEY = "bulkFetchSpacingMs";

// Start each run at the spacing the previous run ended on, so the learned rate
// carries over instead of being rediscovered from a guess every time.
async function loadLearnedSpacing() {
  try { const v = (await chrome.storage.local.get(PACER_STORAGE_KEY))[PACER_STORAGE_KEY]; return Number.isFinite(v) ? v : 2500; }
  catch { return 2500; }
}
async function saveLearnedSpacing(ms) {
  try { await chrome.storage.local.set({ [PACER_STORAGE_KEY]: ms }); } catch (err) { handlePossibleContextInvalidation(err); }
}

async function loadAutoCapturePacer() {
  if (autoCapturePacer) return autoCapturePacer;
  let initialMs = 3000;
  try {
    const v = (await chrome.storage.local.get(AUTO_CAPTURE_PACER_STORAGE_KEY))[AUTO_CAPTURE_PACER_STORAGE_KEY];
    if (Number.isFinite(v)) initialMs = v;
  } catch { /* use default */ }
  autoCapturePacer = new AdaptivePacer({ initialMs, minMs: 2000, maxMs: 120000 });
  return autoCapturePacer;
}
async function saveAutoCapturePacer() {
  try { await chrome.storage.local.set({ [AUTO_CAPTURE_PACER_STORAGE_KEY]: autoCapturePacer.spacingMs }); }
  catch (err) { handlePossibleContextInvalidation(err); }
}
// Mirrors server/index.js's applyRateLimit: AdaptivePacer.onRateLimit only
// returns the retry-after-aware wait, it doesn't persist it into spacingMs.
function applyAutoCaptureRateLimit(retryAfterMs) {
  const suggested = autoCapturePacer.onRateLimit(retryAfterMs);
  if (retryAfterMs != null) autoCapturePacer.spacingMs = Math.max(autoCapturePacer.spacingMs, suggested);
}

// Purely local (thread id, DOM message count/role/length) -- zero network
// cost, sent over the already-open broker WebSocket so Brian's own ChatGPT
// activity is visible and timestamped without any extra request against
// ChatGPT itself. Fires on every scheduleArchive debounce, whether or not
// the capture attempt below actually proceeds.
function reportDomActivity(threadId, domKey, outcome) {
  try {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "dom_activity", thread_id: threadId, dom_key: domKey, outcome }));
    }
  } catch { /* best-effort; never block capture on this */ }
}

// `known` (thread id -> last_captured_at) switches to incremental mode: only
// conversations new or updated since their last capture are fetched.
async function archiveAllChats({ known = null } = {}) {
  if (bulkArchiving) throw new Error("A bulk archive is already running.");
  bulkArchiving = true;
  const summary = { mode: known ? "incremental" : "full", listed: 0, total: 0, skipped: 0, archived: 0, failed: [], fatal_error: null, pacing: null };
  const pacer = new AdaptivePacer({ initialMs: await loadLearnedSpacing() });
  try {
    const accessToken = await getAccessToken();
    const listed = await listAllConversations({ accessToken, onPage: (loaded, total) => (summary.total = total) });
    const conversations = known ? selectChangedConversations(listed, known) : listed;
    summary.listed = listed.length;
    summary.skipped = listed.length - conversations.length;
    summary.total = conversations.length;
    const tokenRef = { token: accessToken };
    let consecutiveFailures = 0;
    for (const conv of conversations) {
      try {
        const apiResult = await captureWithRecovery(conv.id, { tokenRef, pacer });
        const snapshot = buildSnapshot({
          threadId: conv.id,
          title: apiResult.title || conv.title || null,
          titleSource: "api",
          url: `https://chatgpt.com/c/${conv.id}`,
          messages: apiResult.messages,
          captureSource: "api",
          completenessWarning: null,
        });
        if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "thread_snapshot", snapshot }));
        summary.archived++;
        consecutiveFailures = 0;
      } catch (err) {
        summary.failed.push({ thread_id: conv.id, title: conv.title || null, error: err.message });
        consecutiveFailures++;
        // Stop instead of failing every remaining conversation: a persistent
        // rate limit or a systemic error will not clear by trying the next one.
        // Unfetched conversations are simply picked up by the next incremental run.
        if (err.abortRun || consecutiveFailures >= 10) {
          summary.fatal_error = err.abortRun ? err.message : `stopped after ${consecutiveFailures} consecutive failures; last: ${err.message}`;
          break;
        }
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "bulk_archive_progress", done: summary.archived + summary.failed.length, total: summary.total, archived: summary.archived, failed: summary.failed.length, ...pacer.stats() }));
      }
      // ChatGPT rate-limits conversation fetches (a fixed 200ms gap hit HTTP 429
      // after ~170 of 795 on 2026-09-14); the adaptive pacer finds the gap.
      await sleep(pacer.spacingMs);
    }
  } catch (err) {
    summary.fatal_error = err.message;
  } finally {
    bulkArchiving = false;
    summary.pacing = pacer.stats();
    await saveLearnedSpacing(pacer.spacingMs);
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "bulk_archive_complete", ...summary }));
  }
  await log("info", `bulk archive complete: ${summary.archived}/${summary.total} archived, ${summary.failed.length} failed`);
  return summary;
}

// -- broker command handling ----------------------------------------------------

async function handleCommand(msg) {
  if (msg.action === "get_current_chat_title") return { title: resolveTitle(null).title };
  if (msg.action === "get_current_thread_info") {
    const threadId = currentThreadId();
    return {
      thread_id: threadId,
      title: resolveTitle(null).title,
      url: location.href,
      capture_source: threadId === status.threadId ? status.captureSource : null,
      completeness_warning: threadId === status.threadId ? status.completenessWarning : null,
    };
  }
  if (msg.action === "capture_current_chat") {
    const s = await sendSnapshot(true);
    return { thread_id: s.thread_id, title: s.title, message_count: s.messages.length, capture_source: s.capture_source, completeness_warning: s.completeness_warning };
  }
  if (msg.action === "rename_current_chat") {
    const title = String(msg.title || "").trim();
    if (!title || title.length > 120) throw new Error("Title must be 1-120 characters.");
    const targetThreadId = msg.thread_id || undefined;
    return { title: await renameViaVisibleUi(title, targetThreadId), thread_id: targetThreadId || currentThreadId() };
  }
  if (msg.action === "move_to_project") {
    const project = String(msg.project || "").trim();
    if (!project) throw new Error("Project name is required.");
    const targetThreadId = msg.thread_id || undefined;
    const result = await moveToProjectViaVisibleUi(project, targetThreadId);
    return { ...result, thread_id: targetThreadId || currentThreadId() };
  }
  if (msg.action === "list_recent_chats") {
    const limit = Math.min(Math.max(Number(msg.limit) || 28, 1), 100);
    const page = await listConversationsPage({ offset: 0, limit });
    return { chats: page.items.map((c) => ({ id: c.id, title: c.title || "", update_time: c.update_time ?? null })), total: page.total ?? null };
  }
  if (msg.action === "get_tab") return { tab: TAB_TOKEN, page_id: PAGE_ID, agent: AGENT_TAB, busy: bulkArchiving, thread_id: currentThreadId(), account: tabIdentity };
  if (msg.action === "list_project_chats") {
    const perProject = Math.min(Math.max(Number(msg.per_project) || 20, 1), 100);
    return { projects: await listProjectChats({ perProject }) };
  }
  if (msg.action === "read_conversation") {
    // Reads any conversation this tab's account can see, by id, without
    // navigating or sending anything. Images are resolved to bytes here
    // because nothing past this page can dereference ChatGPT's signed URLs;
    // an image that fails is reported with its error, never silently dropped.
    const threadId = String(msg.thread_id || "").trim();
    if (!threadId) throw new Error("read_conversation requires thread_id");
    const data = await fetchConversationTree(threadId);
    const messages = linearizeMapping(data);
    const images = [];
    if (msg.include_images !== false) {
      const maxImages = Math.min(Math.max(Number(msg.max_images) || 40, 0), 200);
      for (const ref of imagesInMessages(messages).slice(0, maxImages)) {
        try { images.push({ ...ref, ...(await fetchImageAsDataParts(await resolveFileDownloadUrl(ref.asset_pointer))) }); }
        catch (err) { images.push({ ...ref, error: err.message }); }
      }
    }
    // Same completion rule ask_chatgpt uses, so a caller collecting a reply
    // that outlived its ask_chatgpt timeout can tell a finished answer from
    // one ChatGPT is still writing.
    let latestReplyFinished = null;
    try { latestReplyFinished = replyFromTree(data, 0).done; } catch { /* unreadable tree: unknown */ }
    return { thread_id: threadId, title: typeof data.title === "string" ? data.title : null,
             project_id: data.conversation_template_id || data.gizmo_id || null,
             messages, images, account: tabIdentity, latest_reply_finished: latestReplyFinished };
  }
  if (msg.action === "reload_tab") {
    // Same fire-and-forget shape as navigate_home/navigate_to_thread below:
    // the reply is sent synchronously before location.reload() tears this
    // content-script instance down. Exists so a reload of the extension
    // itself (chrome://extensions, which this content script cannot trigger
    // on itself) can be followed by refreshing an already-open tab from the
    // broker, instead of Brian doing it by hand -- Chrome loads content
    // scripts per document load using whatever extension version is
    // currently installed, so this refresh is only useful AFTER the
    // extension has actually been reloaded.
    location.reload();
    return { reloaded: true };
  }
  if (msg.action === "navigate_home") {
    refuseWhileArchiving("navigating");
    location.href = "https://chatgpt.com/";
    return { navigated: true };
  }
  if (msg.action === "retry_send_click") return retrySendClick(String(msg.expected || ""), msg.thread_before || null, msg.messages_before ?? null, msg.exclude_threads || []);
  if (msg.action === "send_prompt") return sendPrompt(msg.text, msg.exclude_threads || []);
  if (msg.action === "get_reply") return getReply(msg.dom_before, msg.messages_before, msg.expected ?? null, msg.exclude_threads || [], msg.thread_hint || null);
  if (msg.action === "navigate_to_thread") {
    refuseWhileArchiving("navigating");
    const threadId = String(msg.thread_id || "").trim();
    if (!threadId) throw new Error("thread_id is required.");
    if (currentThreadId() === threadId) return { thread_id: threadId, navigated: false };
    // A full navigation tears down this content-script instance immediately —
    // there is no "after" to await. The response below is sent synchronously
    // before location.href takes effect; the caller must treat this as
    // fire-and-forget and poll get_current_thread_info afterward rather than
    // expecting this same command to also confirm arrival.
    location.href = `https://chatgpt.com/c/${threadId}`;
    return { thread_id: threadId, navigated: true };
  }
  if (msg.action === "get_capabilities") return CAPABILITIES;
  if (msg.action === "debug_inspect_toolbar") {
    // Temporary, read-only reconnaissance for adding thinking-level control:
    // dump every clickable control near the composer (text, aria-label,
    // data-testid, role) instead of guessing selectors blind -- this repo's
    // own changelog shows two prior bugs from hardcoding a DOM guess
    // ("Skip to content"). Not wired to any MCP tool; safe to remove once
    // the real picker is identified.
    const composer = findFirst(COMPOSER_SELECTORS, visible);
    const scope = composer ? composer.el.closest("form") || document.body : document.body;
    const els = [...scope.querySelectorAll("button, [role=\"button\"], [role=\"menuitem\"], [data-testid]")];
    // Every editable on the page, so a composer-selector miss can be diagnosed
    // from the live DOM instead of guessed.
    const editables = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].slice(0, 20).map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: (el.className && typeof el.className === "string" ? el.className : "").slice(0, 120),
      role: el.getAttribute("role"),
      testId: el.getAttribute("data-testid"),
      placeholder: el.getAttribute("placeholder") || el.getAttribute("data-placeholder"),
      ariaLabel: el.getAttribute("aria-label"),
      visible: visible(el),
      inForm: Boolean(el.closest("form")),
      ancestorTestIds: (() => { const out = []; let n = el.parentElement; while (n && out.length < 4) { const t = n.getAttribute && n.getAttribute("data-testid"); if (t) out.push(t); n = n.parentElement; } return out; })(),
    }));
    return {
      composerSelector: composer ? composer.selector : null,
      editables,
      candidates: els.slice(0, 60).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || "").trim().slice(0, 60),
        ariaLabel: el.getAttribute("aria-label"),
        testId: el.getAttribute("data-testid"),
        role: el.getAttribute("role"),
        expanded: el.getAttribute("aria-expanded"),
      })),
    };
  }
  if (msg.action === "debug_click_and_inspect") {
    // Temporary, read-only reconnaissance: click the first visible button
    // whose text matches msg.text (e.g. the "Instant" thinking-level
    // trigger), wait briefly for its menu to render, then dump every
    // clickable control document-wide (a dropdown is often portaled to
    // document.body, not nested under the composer). Escape afterward to
    // leave the UI as found. Not wired to any MCP tool.
    const target = [...document.querySelectorAll("button, [role=\"button\"]")]
      .find((el) => visible(el) && (el.textContent || "").trim() === String(msg.text || "").trim());
    if (!target) throw new Error(`no visible button with text "${msg.text}" found.`);
    // A bare .click() doesn't always trigger a Radix/React dropdown that
    // listens for pointer events specifically. Dispatch the full sequence a
    // real mouse click produces.
    const rect = target.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      target.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, opts));
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        const els = [...document.querySelectorAll("button, [role=\"button\"], [role=\"menuitem\"], [role=\"menuitemradio\"], [data-testid], [data-radix-menu-content], [id^=radix]")];
        const candidates = els.slice(0, 80).map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || "").trim().slice(0, 60),
          ariaLabel: el.getAttribute("aria-label"),
          testId: el.getAttribute("data-testid"),
          role: el.getAttribute("role"),
          checked: el.getAttribute("aria-checked"),
          expanded: el.getAttribute("aria-expanded"),
        }));
        resolve({ target_expanded_after: target.getAttribute("aria-expanded"), candidates });
      }, 500);
    });
  }
  if (msg.action === "archive_all_chats") {
    if (bulkArchiving) throw new Error("A bulk archive is already running.");
    archiveAllChats({ known: msg.known || null }).catch((err) => log("error", "bulk archive failed", err));
    return { started: true };
  }
  throw new Error(`Unknown action: ${msg.action}`);
}

// -- broker connection ------------------------------------------------------------

// Which ChatGPT account this tab is signed into, so the broker can route reads
// and asks to a tab that can see the target account's conversations. Sent on
// every (re)connect; a failure is reported to the broker rather than hidden.
let tabIdentity = null;
async function reportIdentity() {
  try { tabIdentity = await getSessionIdentity(); }
  catch (err) { tabIdentity = null; await log("warn", "could not read this tab's ChatGPT account", err); }
  try { socket?.send(JSON.stringify({ type: "identity", account: tabIdentity })); } catch {}
}

// Wakes the background worker so it checks for a new extension version now
// (not only on its minute alarm), and tells the broker whether it answered:
// without a worker the extension cannot reload itself, and nothing else notices.
async function reportBackground() {
  const status = await pingBackground((msg) => chrome.runtime.sendMessage(msg));
  if (!status.ok && handlePossibleContextInvalidation(status.error)) return;
  try { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "background_status", ...status })); } catch {}
}

async function connect() {
  if (contextInvalidated) return;
  clearTimeout(reconnectTimer);
  let cfg;
  try {
    cfg = await chrome.storage.sync.get(DEFAULTS);
  } catch (err) {
    if (handlePossibleContextInvalidation(err)) return;
    throw err;
  }
  let url;
  try {
    url = new URL(cfg.brokerUrl || DEFAULTS.brokerUrl);
  } catch {
    setStatus({ connected: false, lastArchiveError: "Invalid broker URL in extension options." });
    return;
  }
  url.searchParams.set("token", cfg.token || DEFAULTS.token);
  url.searchParams.set("tab", TAB_TOKEN);
  if (AGENT_TAB) url.searchParams.set("agent", "1");
  // Lets the broker see which extension version each tab is really running
  // (a merged change only runs once Chrome has reloaded the extension).
  try { url.searchParams.set("v", chrome.runtime.getManifest().version); } catch {}
  socket = new WebSocket(url.toString());
  socket.onopen = () => {
    setStatus({ connected: true });
    log("info", "broker connected");
    scheduleArchive();
    reportIdentity();
    reportBackground();
  };
  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "hello") return;
    if (msg.type === "snapshot_ack") {
      setStatus({ lastArchiveAt: new Date().toISOString(), lastArchiveStatus: "ok", lastArchiveError: null });
      return;
    }
    if (msg.type === "snapshot_error") {
      setStatus({ lastArchiveStatus: "error", lastArchiveError: msg.error || "Archive rejected by broker." });
      await log("error", "broker rejected snapshot", msg.error);
      return;
    }
    if (msg.type !== "command") return;
    // Attached to every reply, success or failure, so the broker's request
    // log can see which physical tab/context actually made each request
    // without threading this through every individual action handler.
    const requestContext = { tab: TAB_TOKEN, agent: AGENT_TAB, incognito: INCOGNITO };
    try {
      const result = await handleCommand(msg);
      socket.send(JSON.stringify({ type: "command_result", id: msg.id, ok: true, ...requestContext, ...result }));
      if ((msg.action === "navigate_to_thread" || msg.action === "navigate_home") && result.navigated) {
        // location.href is about to tear this content-script instance down
        // anyway. Closing proactively (instead of waiting for the browser to
        // notice) keeps the broker from briefly counting both this dying
        // socket and the fresh instance's new one as live at the same time —
        // that overlap was causing move-to-project commands to occasionally
        // race against a stale, already-navigating-away page.
        socket.close();
      }
    } catch (err) {
      socket.send(JSON.stringify({ type: "command_result", id: msg.id, ok: false, ...requestContext, ...(err.reply || {}), error: err.message }));
      await log("error", `command ${msg.action} failed`, err);
    }
  };
  socket.onclose = (event) => {
    setStatus({ connected: false });
    // 4001: the broker saw another live socket with this tab's token. If this
    // code is still current (a duplicated tab shares sessionStorage), take a
    // fresh in-memory token so both tabs stay connected. Deliberately not
    // written back to sessionStorage: a page being torn down can receive 4001
    // too, and rewriting the shared token under the page that replaces it
    // would break agents waiting on that tab by token. Superseded code stops
    // on its own when connect() hits the invalidated extension context.
    if (event?.code === 4001) TAB_TOKEN = crypto.randomUUID();
    if (!contextInvalidated) reconnectTimer = setTimeout(connect, 2000);
  };
  socket.onerror = () => {
    setStatus({ connected: false, lastArchiveError: "Broker connection error (is the backend running and is the token correct?)." });
    socket.close();
  };
}

const observer = new MutationObserver(() => scheduleArchive());
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
window.addEventListener("popstate", scheduleArchive);
window.addEventListener("focus", scheduleArchive);
setInterval(() => {
  if (!contextInvalidated) scheduleArchive();
}, 15000);

// Only reconnect when broker settings actually change (storage.sync, written
// by the options page). storage.local is written on every status update
// (persistStatus()) — reacting to that too created a feedback loop: capture
// -> status write -> reconnect -> re-capture -> ... which flooded the broker
// with connections (observed: 250+ simultaneous sockets, Chrome eventually
// throttling new WebSocket attempts with "Insufficient resources").
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== "sync") return;
  try {
    socket?.close();
  } catch {}
  connect();
});
connect();
})();
