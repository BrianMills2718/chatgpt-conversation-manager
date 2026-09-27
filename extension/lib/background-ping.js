// Asks the extension's background worker to run its update check (waking it if
// it is idle) and reports whether it answered. A tab calls this each time it
// connects to the broker and forwards the result, so a missing worker, which
// means the extension can no longer reload itself onto a new version, shows up
// at the broker instead of failing silently (it did, 2026-09-26 to 09-27).
// `sendMessage` is chrome.runtime.sendMessage; injected so it can be tested.
export async function pingBackground(sendMessage) {
  try {
    const reply = await sendMessage({ type: "ccm-update-check" });
    if (reply?.alive) return { ok: true, version: reply.version ?? null };
    return { ok: false, error: "the background worker gave no answer" };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
