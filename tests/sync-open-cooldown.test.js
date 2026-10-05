import test from 'node:test';
import assert from 'node:assert';
import { SyncScheduler } from '../server/sync.js';

function make(openCommand) {
  const logs = [];
  const s = new SyncScheduler({ archive: {}, dispatch: async () => ({}), connectionCount: () => 0, waitForBulkComplete: async () => ({}), statusPath: '/tmp/sync-cooldown-test.json',
    openCommand, connectWaitMs: 10, log: { log: (m) => logs.push(m), error: (m) => logs.push(m) } });
  return { s, logs };
}

test('the open command runs once per account per cooldown window, not on every retry', async () => {
  const { s, logs } = make('true');
  s.openCooldownMs = 60000;
  await assert.rejects(s.ensureConnected('a@x.com'), /within/);          // first attempt opens and times out
  await assert.rejects(s.ensureConnected('a@x.com'), /not opening another tab/);   // retry: no second open
  await assert.rejects(s.ensureConnected('b@x.com'), /within/);          // a different account gets its own single attempt
  assert.strictEqual(logs.filter((l) => l.includes('running SYNC_OPEN_CHATGPT_CMD')).length, 2);
});
