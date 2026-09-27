// Polls `predicate` until it returns a truthy value or `timeout` ms pass.
//
// Always checks once more after the deadline. In a hidden tab Chrome can
// throttle timers to about one wake-up a minute, so a single sleep can
// overshoot the whole window. The old loop then exited without looking
// again: it checked once at t=0, woke ~60s later, and reported "no composer
// found" without checking the page it had waited for. 2026-09-27 sends failed
// that way after 49-74s against a 15s window. The thrown error carries
// `checks` so a failure shows how many looks actually happened.
export async function waitFor(predicate, timeout = 5000, interval = 80, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const start = now();
  let checks = 0;
  for (;;) {
    checks++;
    const value = predicate();
    if (value) return value;
    if (now() - start >= timeout) {
      throw Object.assign(new Error("Timed out waiting for ChatGPT UI."), { checks, waited_ms: now() - start });
    }
    await sleep(interval);
  }
}
