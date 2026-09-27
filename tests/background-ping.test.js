import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pingBackground } from '../extension/lib/background-ping.js';

test('a live worker answers with its version', async () => {
  let sent;
  const status = await pingBackground(async (msg) => { sent = msg; return { alive: true, version: '0.7.6' }; });
  assert.deepEqual(sent, { type: 'ccm-update-check' });
  assert.deepEqual(status, { ok: true, version: '0.7.6' });
});

test('no registered worker is reported with Chrome\'s own error, not thrown', async () => {
  const status = await pingBackground(async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); });
  assert.deepEqual(status, { ok: false, error: 'Could not establish connection. Receiving end does not exist.' });
});

test('a worker that does not answer counts as not ok', async () => {
  assert.equal((await pingBackground(async () => undefined)).ok, false);
});
