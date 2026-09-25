// Keeps the extension current without Brian touching the browser.
//
// 1. On install or update, inject the content script into every chatgpt.com tab
//    that is already open. Chrome only runs manifest content scripts on pages
//    loaded AFTER install/update, so without this every open tab kept running
//    old code (or none) until someone refreshed it by hand.
// 2. Once a minute, ask the broker which extension version is on disk. If it
//    differs from the running one, reload the extension. For an unpacked
//    extension chrome.runtime.reload() re-reads the files from disk, and the
//    resulting onInstalled("update") re-injects into open tabs (step 1). So a
//    merged extension change reaches every browser with no manual reload.
//    Requires the manifest version to be bumped with every extension change.

const DEFAULT_BROKER = "ws://localhost:8787/extension";

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  for (const tab of tabs) {
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); }
    catch (err) { console.warn(`[ccm] could not inject into tab ${tab.id} (${tab.url}): ${err.message}`); }
  }
}

chrome.runtime.onInstalled.addListener(() => { injectIntoOpenTabs(); });

async function healthUrl() {
  const { brokerUrl } = await chrome.storage.sync.get({ brokerUrl: DEFAULT_BROKER });
  const url = new URL(brokerUrl || DEFAULT_BROKER);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/health";
  url.search = "";
  return url.toString();
}

async function checkForUpdate() {
  const res = await fetch(await healthUrl(), { cache: "no-store" });
  if (!res.ok) throw new Error(`broker health HTTP ${res.status}`);
  const onDisk = (await res.json()).extension_version;
  const running = chrome.runtime.getManifest().version;
  if (onDisk && onDisk !== running) {
    console.info(`[ccm] extension ${running} is running but ${onDisk} is on disk; reloading`);
    chrome.runtime.reload();
  }
}

chrome.alarms.create("ccm-update-check", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "ccm-update-check") return;
  checkForUpdate().catch((err) => console.warn(`[ccm] update check failed: ${err.message}`));
});
