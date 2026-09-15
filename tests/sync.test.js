import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncScheduler } from '../server/sync.js';

function setup({ connected = 1, completion, dispatchError = null, openCommand = null, oldExtension = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  const archive = { readCatalog: () => ({ threads: { a: { last_captured_at: '2026-09-14T20:00:00.000Z' }, b: {} } }) };
  const sent = [];
  let conn = connected;
  const sched = new SyncScheduler({
    archive,
    dispatch: async (cmd) => {
      sent.push(cmd);
      if (cmd.action === 'get_capabilities') { if (oldExtension) throw new Error('Unknown action: get_capabilities'); return { ok: true, incremental_archive: true }; }
      if (dispatchError) throw dispatchError;
      return { ok: true, started: true };
    },
    connectionCount: () => conn,
    waitForBulkComplete: () => completion,
    statusPath: path.join(dir, 'metadata', 'sync-status.json'),
    openCommand,
    connectWaitMs: 50,
    log: { log() {}, error() {} },
  });
  return { sched, sent, setConn: (n) => { conn = n; } };
}

test('a successful run sends known capture times and records the summary', async () => {
  const { sched, sent } = setup({ completion: Promise.resolve({ mode: 'incremental', listed: 800, total: 3, skipped: 797, archived: 3, failed: [], fatal_error: null }) });
  const status = await sched.runOnce();
  assert.deepEqual(sent, [{ action: 'get_capabilities' }, { action: 'archive_all_chats', known: { a: '2026-09-14T20:00:00.000Z' } }]);
  assert.equal(status.in_progress, false);
  assert.equal(status.last_error, null);
  assert.deepEqual(status.last_result, { mode: 'incremental', listed: 800, fetched: 3, skipped: 797, archived: 3, failed: 0, pacing: null });
  assert.ok(status.last_success_at);
});

test('an extension fatal error is recorded as a failure, not a success', async () => {
  const { sched } = setup({ completion: Promise.resolve({ fatal_error: 'HTTP 401', failed: [] }) });
  const status = await sched.runOnce();
  assert.equal(status.last_success_at, undefined);
  assert.match(status.last_error, /HTTP 401/);
});

test('no connected tab and no open command fails loudly', async () => {
  const { sched, sent } = setup({ connected: 0, completion: new Promise(() => {}) });
  const status = await sched.runOnce();
  assert.equal(sent.length, 0);
  assert.match(status.last_error, /No chatgpt.com tab is connected/);
});

test('a prior success survives a later failure so staleness stays visible', async () => {
  const ok = setup({ completion: Promise.resolve({ mode: 'incremental', listed: 1, total: 0, skipped: 1, archived: 0, failed: [] }) });
  const first = await ok.sched.runOnce();
  ok.sched.waitForBulkComplete = () => Promise.resolve({ fatal_error: 'boom' });
  const second = await ok.sched.runOnce();
  assert.equal(second.last_success_at, first.last_success_at);
  assert.match(second.last_error, /boom/);
});

test('an extension without incremental support is refused before any archive command', async () => {
  const { sched, sent } = setup({ oldExtension: true, completion: new Promise(() => {}) });
  const status = await sched.runOnce();
  assert.deepEqual(sent.map((c) => c.action), ['get_capabilities']);
  assert.match(status.last_error, /running old code.*Unknown action/);
});

test('nextDelayMs retries a failed run sooner and keeps the interval after success', () => {
  const H6 = 6 * 60 * 60 * 1000;
  assert.equal(SyncScheduler.nextDelayMs({ last_success_at: '2026-09-15T01:00:00.000Z', last_error: null }, H6), H6);
  assert.equal(SyncScheduler.nextDelayMs({ last_error: 'x', last_error_at: '2026-09-15T01:00:00.000Z' }, H6), 30 * 60 * 1000);
  assert.equal(SyncScheduler.nextDelayMs({ last_error: 'old', last_error_at: '2026-09-15T00:00:00.000Z', last_success_at: '2026-09-15T01:00:00.000Z' }, H6), H6);
});

test('a refused dispatch leaves no unhandled rejection behind when the wait times out', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let rejectLater;
    const completion = new Promise((_, reject) => { rejectLater = reject; });
    const { sched } = setup({ completion, dispatchError: new Error('A bulk archive is already running.') });
    const status = await sched.runOnce();
    assert.match(status.last_error, /already running/);
    rejectLater(new Error('bulk archive did not complete within 120 minutes'));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

