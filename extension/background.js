// Keeps the extension current without Brian touching the browser.
//
// 1. On install or update, inject the content script into every chatgpt.com tab
//    that is already open. Chrome only runs manifest content scripts on pages
//    loaded AFTER install/update, so without this every open tab kept running
//    old code (or none) until someone refreshed it by hand.
// 2. Ask the broker's /health which extension version is on disk. If it differs
//    from the running one, reload the extension. For an unpacked extension
//    chrome.runtime.reload() re-reads the files from disk, and the resulting
//    onInstalled("update") re-injects into open tabs (step 1). Requires the
//    manifest version to be bumped with every extension change.
//
// The check runs on three triggers, because one was not enough: a
// chrome.alarms alarm every minute, browser startup, and a ping that every
// ChatGPT tab sends when it connects to the broker. On 2026-09-26 21:21Z the
// first real self-reload in Brian's Chrome left the extension with no
// registered service worker (Chrome's own state on disk: old registration
// deleted, no new one), and with the alarm as the only trigger nothing noticed:
// 0.7.2-0.7.5 each sat on disk unloaded. The tab ping wakes a worker that is
// registered but idle, and when there is no worker at all the tab tells the
// broker, which warns that a manual reload is needed.

const DEFAULT_BROKER = "ws://localhost:8787/extension";
const ALARM = "ccm-update-check";
// A reload whose result still differs from disk (for example the broker reads a
// different checkout than Chrome loads) must not turn into a reload loop, which
// would also re-inject every tab and cut off in-flight asks.
const MIN_RELOAD_GAP_MS = 5 * 60 * 1000;

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  for (const tab of tabs) {
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); }
    catch (err) { console.warn(`[ccm] could not inject into tab ${tab.id} (${tab.url}): ${err.message}`); }
  }
}

async function healthUrl() {
  const { brokerUrl } = await chrome.storage.sync.get({ brokerUrl: DEFAULT_BROKER });
  const url = new URL(brokerUrl || DEFAULT_BROKER);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/health";
  url.search = "";
  return url.toString();
}

async function checkForUpdate(trigger) {
  const res = await fetch(await healthUrl(), { cache: "no-store" });
  if (!res.ok) throw new Error(`broker health HTTP ${res.status}`);
  const onDisk = (await res.json()).extension_version;
  const running = chrome.runtime.getManifest().version;
  if (!onDisk || onDisk === running) return;
  // chrome.storage.local survives chrome.runtime.reload(), so this sees the
  // previous worker's reload.
  const { lastReloadAt } = await chrome.storage.local.get({ lastReloadAt: 0 });
  const sinceMs = Date.now() - lastReloadAt;
  if (sinceMs < MIN_RELOAD_GAP_MS) {
    console.warn(`[ccm] extension ${running} is running but ${onDisk} is on disk, and the last reload was ${Math.round(sinceMs / 1000)}s ago; not reloading again for ${Math.round((MIN_RELOAD_GAP_MS - sinceMs) / 1000)}s`);
    return;
  }
  await chrome.storage.local.set({ lastReloadAt: Date.now() });
  console.info(`[ccm] extension ${running} is running but ${onDisk} is on disk; reloading (trigger: ${trigger})`);
  chrome.runtime.reload();
}

function runCheck(trigger) {
  checkForUpdate(trigger).catch((err) => console.warn(`[ccm] update check (${trigger}) failed: ${err.message}`));
}

// Create the alarm only when it is missing. Chrome clears alarms when the
// extension updates, so a fresh worker must create it; but re-creating an
// existing alarm restarts its one-minute countdown, so a worker woken more often
// than once a minute (tab pings) would otherwise never reach the alarm.
async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

// All listeners are registered synchronously at top level: Chrome only
// delivers an event that woke the worker to listeners registered in the first
// turn of the script.
ensureAlarm().catch((err) => console.warn(`[ccm] could not create the update alarm: ${err.message}`));
chrome.runtime.onInstalled.addListener(() => { injectIntoOpenTabs(); runCheck("installed"); });
chrome.runtime.onStartup.addListener(() => { runCheck("startup"); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) runCheck("alarm"); });
// A failure here must not stop the worker: it also keeps the extension
// updating itself (see the top of this file).
try { importScripts("lib/plain-text-mode.js"); } catch (err) { console.warn(`[ccm] plain-text-mode helper not loaded: ${err.message}`); }

// A content script cannot reach the page's own JavaScript objects (it runs in
// an isolated world), so the plain-text switch runs in the page's main world
// from here, only for the tab that asked (lib/plain-text-mode.js).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const req = msg?.type === "ccm-composer-main" ? msg.req : msg?.type === "ccm-plain-text-mode" ? { op: "plain", on: msg.on !== false } : null;
  if (!req || !sender.tab?.id) return;
  Promise.resolve()
    .then(() => chrome.scripting.executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, world: "MAIN", func: self.composerMainWorld, args: [req] }))
    .then((results) => sendResponse(results?.[0]?.result ?? { ok: false, reason: "no result from the page" }))
    .catch((err) => sendResponse({ ok: false, reason: String(err?.message || err) }));
  return true;
});

// Exempt the asking agent tab from automatic discarding (Memory Saver).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "ccm-agent-tab-keepalive" || !sender.tab?.id) return;
  chrome.tabs.update(sender.tab.id, { autoDiscardable: false })
    .then((t) => sendResponse({ ok: true, auto_discardable: t?.autoDiscardable ?? null, discarded: t?.discarded ?? null, frozen: t?.frozen ?? null }))
    .catch((err) => sendResponse({ ok: false, reason: String(err?.message || err) }));
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "ccm-update-check") return;
  // Answer before checking: a reload would end this worker before a later reply.
  sendResponse({ alive: true, version: chrome.runtime.getManifest().version });
  runCheck("tab");
});
