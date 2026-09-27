import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../extension/lib/wait-for.js';

// A fake clock whose every sleep overshoots to 60s, like a hidden tab under
// Chrome's intensive timer throttling.
function throttledClock() {
  let t = 0;
  return { now: () => t, sleep: async () => { t += 60000; } };
}

test('a value that appears during one throttled sleep past the deadline is still found', async () => {
  const clock = throttledClock();
  let composer = null;
  const found = waitFor(() => composer, 15000, 80, { now: clock.now, sleep: async (ms) => { await clock.sleep(ms); composer = 'the composer'; } });
  assert.equal(await found, 'the composer');
});

test('a value that never appears fails after a final check, reporting how many checks ran', async () => {
  const clock = throttledClock();
  let calls = 0;
  const err = await waitFor(() => { calls++; return null; }, 15000, 80, clock).then(() => null, (e) => e);
  assert.ok(err);
  assert.match(err.message, /Timed out waiting for ChatGPT UI/);
  assert.equal(err.checks, 2);
  assert.equal(calls, 2);
  assert.equal(err.waited_ms, 60000);
});

test('an unthrottled wait still polls at its interval and returns as soon as the value appears', async () => {
  let t = 0;
  let calls = 0;
  const v = await waitFor(() => (++calls === 5 ? 'ok' : null), 15000, 80, { now: () => t, sleep: async (ms) => { t += ms; } });
  assert.equal(v, 'ok');
  assert.equal(t, 320);
});
