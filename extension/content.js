// Chrome content scripts run as classic (non-module) scripts — "type": "module"
// is only valid for background service workers, not content_scripts entries, so
// static `import` here throws "Cannot use import statement outside a module".
// Dynamic import() is allowed from a classic script, so the whole file is
// wrapped in an async IIFE that awaits the imports first; everything below
// stays unchanged and closes over these bindings normally.
(async () => {
const { cleanDocumentTitle, selectTitle, isSameOriginPageAnchor } = await import(chrome.runtime.getURL("lib/title.js"));
const { buildSnapshot, snapshotFingerprint } = await import(chrome.runtime.getURL("lib/normalize.js"));
const { captureViaApi, captureWithRecovery, AdaptivePacer, listAllConversations, selectChangedConversations, getAccessToken, getConversationProjectId, fetchConversationTree, linearizeMapping, replyFromTree } = await import(chrome.runtime.getURL("lib/api-capture.js"));

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
let isCapturing = false;
let contextInvalidated = false;

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
async function waitFor(predicate, timeout = 5000, interval = 80) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = predicate();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error("Timed out waiting for ChatGPT UI.");
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

  if (apiResult && apiResult.messages.length) {
    const { title, source } = resolveTitle(apiResult.title);
    return buildSnapshot({
      threadId,
      title,
      titleSource: source,
      url: location.href,
      messages: apiResult.messages,
      captureSource: "api",
      completenessWarning: null,
    });
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
  return buildSnapshot({
    threadId,
    title,
    titleSource: source,
    url: location.href,
    messages: domMessages,
    captureSource: "dom",
    completenessWarning: apiError
      ? `Same-origin API capture unavailable (${apiError.message}); used DOM scraping, which cannot guarantee complete history on long/virtualized conversations.`
      : null,
  });
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
  isCapturing = true;
  try {
    const snapshot = await captureSnapshot();
    const fp = snapshotFingerprint(snapshot);
    if (!force && fp === lastSnapshotFingerprint) return snapshot;
    lastSnapshotFingerprint = fp;
    socket.send(JSON.stringify({ type: "thread_snapshot", snapshot }));
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
  chrome.storage.sync
    .get(DEFAULTS)
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
const CAPABILITIES = { incremental_archive: true, rate_limit_recovery: true, adaptive_pacing: true, ask: true };

// A tab keeps one token across full-page navigations (sessionStorage is per tab
// and per origin), so the broker can address THIS tab again after it navigates
// and reconnects. Without it, a command meant for one tab reaches every tab.
const TAB_TOKEN = (() => {
  try {
    let t = sessionStorage.getItem("ccm_tab_token");
    if (!t) { t = crypto.randomUUID(); sessionStorage.setItem("ccm_tab_token", t); }
    return t;
  } catch { return crypto.randomUUID(); }
})();

// ask_chatgpt ------------------------------------------------------------------

const COMPOSER_SELECTORS = ["#prompt-textarea", 'div[contenteditable="true"][id*="prompt"]', "form textarea"];
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

async function sendPrompt(text) {
  refuseWhileArchiving("sending a prompt");
  const body = String(text || "");
  if (!body.trim()) throw new Error("text is required.");
  const composer = await waitFor(() => findFirst(COMPOSER_SELECTORS, visible), 15000)
    .catch(() => { throw new Error(`no ChatGPT composer found (tried ${COMPOSER_SELECTORS.join(", ")}); the page layout may have changed.`); });
  const threadBefore = realThreadId();
  // Counted on the page, not through the conversation API: that endpoint is
  // rate-limited for the whole account (HTTP 429) whenever archiving has run.
  const domBefore = extractMessagesFromDom().length;
  const el = composer.el;
  el.focus();
  if (el.tagName === "TEXTAREA") {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, body);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, body);
  }
  const typed = (el.value ?? el.innerText ?? "").trim();
  if (!typed.includes(body.trim().slice(0, 40))) {
    throw new Error("the prompt text did not appear in the composer; nothing was sent.");
  }
  const button = await waitFor(() => findFirst(SEND_BUTTON_SELECTORS, (b) => visible(b) && !b.disabled), 8000)
    .catch(() => { throw new Error(`no enabled send button found (tried ${SEND_BUTTON_SELECTORS.join(", ")}); nothing was sent.`); });
  button.el.click();
  await waitFor(() => ((el.value ?? el.innerText ?? "").trim() === "" ? true : null), 10000)
    .catch(() => { throw new Error("clicked send but the composer did not clear; the prompt may not have been sent."); });
  // A new chat first shows a temporary id ("WEB:<uuid>") in the URL and swaps in
  // the real conversation id once the server has created it.
  const threadId = threadBefore || await waitFor(() => realThreadId(), 60000, 250).catch(() => null);
  return { thread_id: threadId, dom_before: domBefore, composer_selector: composer.selector, send_selector: button.selector };
}

function realThreadId() {
  const t = currentThreadId();
  return t && !t.startsWith("WEB:") ? t : null;
}

const STOP_BUTTON_SELECTORS = ['[data-testid="stop-button"]', 'button[aria-label*="Stop"]'];

// Read the reply from the page. Done when ChatGPT is no longer generating, and a
// new assistant message follows our own. The caller requires the same text on
// two consecutive polls before trusting it, so a pause mid-stream is not "done".
async function getReply(domBefore) {
  const generating = Boolean(findFirst(STOP_BUTTON_SELECTORS, visible));
  const messages = extractMessagesFromDom();
  const added = messages.slice(Number(domBefore) || 0);
  const last = messages[messages.length - 1];
  const replies = added.filter((m) => m.role === "assistant");
  const done = !generating && replies.length > 0 && last?.role === "assistant";
  return { done, generating, thread_id: realThreadId(), message_count: messages.length,
           reply: done ? replies.map((m) => m.text).join("\n\n") : null, source: "dom" };
}

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
  if (msg.action === "get_tab") return { tab: TAB_TOKEN, busy: bulkArchiving, thread_id: currentThreadId() };
  if (msg.action === "navigate_home") {
    refuseWhileArchiving("navigating");
    location.href = "https://chatgpt.com/";
    return { navigated: true };
  }
  if (msg.action === "send_prompt") return sendPrompt(msg.text);
  if (msg.action === "get_reply") return getReply(msg.dom_before);
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
  if (msg.action === "archive_all_chats") {
    if (bulkArchiving) throw new Error("A bulk archive is already running.");
    archiveAllChats({ known: msg.known || null }).catch((err) => log("error", "bulk archive failed", err));
    return { started: true };
  }
  throw new Error(`Unknown action: ${msg.action}`);
}

// -- broker connection ------------------------------------------------------------

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
  socket = new WebSocket(url.toString());
  socket.onopen = () => {
    setStatus({ connected: true });
    log("info", "broker connected");
    scheduleArchive();
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
    try {
      const result = await handleCommand(msg);
      socket.send(JSON.stringify({ type: "command_result", id: msg.id, ok: true, ...result }));
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
      socket.send(JSON.stringify({ type: "command_result", id: msg.id, ok: false, error: err.message }));
      await log("error", `command ${msg.action} failed`, err);
    }
  };
  socket.onclose = () => {
    setStatus({ connected: false });
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
