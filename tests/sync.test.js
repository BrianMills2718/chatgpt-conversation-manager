import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncScheduler } from '../server/sync.js';

function setup({ connected = 1, completion, dispatchError = null, openCommand = null, oldExtension = false, syncAccount = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  const archive = { readCatalog: () => ({ threads: { a: { last_captured_at: '2026-09-14T20:00:00.000Z' }, b: {} } }) };
  const sent = [];
  const sentAccounts = [];
  let conn = connected;
  const sched = new SyncScheduler({
    archive,
    dispatch: async (cmd, account) => {
      sent.push(cmd);
      sentAccounts.push(account || null);
      if (cmd.action === 'get_capabilities') { if (oldExtension) throw new Error('Unknown action: get_capabilities'); return { ok: true, incremental_archive: true }; }
      if (dispatchError) throw dispatchError;
      return { ok: true, started: true };
    },
    connectionCount: () => conn,
    waitForBulkComplete: () => completion,
    statusPath: path.join(dir, 'metadata', 'sync-status.json'),
    openCommand,
    syncAccount,
    connectWaitMs: 50,
    log: { log() {}, error() {} },
  });
  return { sched, sent, sentAccounts, statusPath: path.join(dir, 'metadata', 'sync-status.json'), setConn: (n) => { conn = n; } };
}

test('a successful run sends known capture times and records the summary', async () => {
  const { sched, sent } = setup({ completion: Promise.resolve({ mode: 'incremental', listed: 800, total: 3, skipped: 797, archived: 3, failed: [], fatal_error: null }) });
  const status = await sched.runOnce();
  assert.deepEqual(sent, [{ action: 'get_capabilities' }, { action: 'archive_all_chats', known: { a: '2026-09-14T20:00:00.000Z' } }]);
  assert.equal(status.in_progress, false);
  assert.equal(status.last_error, null);
  assert.deepEqual(status.last_result, { account: null, mode: 'incremental', listed: 800, fetched: 3, skipped: 797, archived: 3, failed: 0, pacing: null });
  assert.ok(status.last_success_at);
});

test('a configured sync account is used for capability checks and bulk archive, and appears in status', async () => {
  const account = 'brian@example.com';
  const { sched, sent, sentAccounts } = setup({
    syncAccount: account,
    completion: Promise.resolve({ mode: 'incremental', listed: 2, total: 1, skipped: 1, archived: 1, failed: [], fatal_error: null }),
  });
  const status = await sched.runOnce();
  assert.deepEqual(sent.map((command) => command.action), ['get_capabilities', 'archive_all_chats']);
  assert.deepEqual(sentAccounts, [account, account]);
  assert.equal(status.account, account);
  assert.equal(status.last_result.account, account);
});

test('an extension fatal error is recorded as a failure, not a success', async () => {
  const { sched } = setup({ completion: Promise.resolve({ fatal_error: 'HTTP 401', failed: [] }) });
  const status = await sched.runOnce();
  assert.equal(status.last_success_at, undefined);
  assert.match(status.last_error, /HTTP 401/);
  assert.equal(status.last_error_status, null);
  assert.equal(status.last_error_retry_after_ms, null);
});

test('an extension rate-limit failure persists its status and Retry-After for the scheduler', async () => {
  const { sched } = setup({ completion: Promise.resolve({
    fatal_error: 'conversations list fetch failed: HTTP 429',
    fatal_error_status: 429,
    fatal_error_retry_after_ms: 12000,
  }) });
  const status = await sched.runOnce();
  assert.equal(status.last_error_status, 429);
  assert.equal(status.last_error_retry_after_ms, 12000);
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
  assert.equal(SyncScheduler.nextDelayMs({ last_error: '429', last_error_at: '2026-09-15T01:00:00.000Z', last_error_status: 429, last_error_retry_after_ms: 1000 }, H6), H6);
  assert.equal(SyncScheduler.nextDelayMs({ last_error: '429', last_error_at: '2026-09-15T01:00:00.000Z', last_error_status: 429, last_error_retry_after_ms: 7 * H6 }, H6), 7 * H6);
});

test('startupDelayMs preserves a future scheduled retry across service restarts', () => {
  const now = Date.parse('2026-09-30T16:00:00.000Z');
  const futureRun = new Date(now + 5 * 60 * 1000).toISOString();
  assert.equal(SyncScheduler.startupDelayMs({ next_run_at: futureRun }, now), 5 * 60 * 1000);
  assert.equal(SyncScheduler.startupDelayMs({}, now), 60 * 1000);
  assert.equal(SyncScheduler.startupDelayMs({ next_run_at: new Date(now - 1).toISOString() }, now), 60 * 1000);
});

test('start schedules from a saved future next_run_at instead of resetting to 60 seconds', () => {
  const { sched, statusPath } = setup({ completion: Promise.resolve({}) });
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify({ next_run_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() }));
  const originalSetTimeout = globalThis.setTimeout;
  let scheduledDelayMs = null;
  globalThis.setTimeout = (_callback, delayMs) => {
    scheduledDelayMs = delayMs;
    return 1;
  };
  try {
    sched.start(6 * 60 * 60 * 1000);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.ok(scheduledDelayMs > 4 * 60 * 1000, `expected saved deadline, got ${scheduledDelayMs}ms`);
  assert.ok(scheduledDelayMs <= 5 * 60 * 1000, `deadline must not be extended, got ${scheduledDelayMs}ms`);
});

test('start chunks a long saved retry deadline within Node timer limits', () => {
  const { sched, statusPath } = setup({ completion: Promise.resolve({}) });
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const deadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(statusPath, JSON.stringify({ next_run_at: deadline }));
  const originalSetTimeout = globalThis.setTimeout;
  let scheduledDelayMs = null;
  globalThis.setTimeout = (_callback, delayMs) => {
    scheduledDelayMs = delayMs;
    return 1;
  };
  try {
    sched.start(6 * 60 * 60 * 1000);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(scheduledDelayMs, 2_147_483_647);
  assert.ok(Date.parse(JSON.parse(fs.readFileSync(statusPath, 'utf8')).next_run_at) > Date.now() + 29 * 24 * 60 * 60 * 1000);
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

test('a comma-separated sync account list archives every account in turn, in order', async () => {
  const { sched, sentAccounts } = setup({
    syncAccount: 'a@example.com, b@example.com',
    completion: Promise.resolve({ mode: 'incremental', listed: 2, total: 1, skipped: 1, archived: 1, failed: [], fatal_error: null }),
  });
  assert.deepEqual(sched.syncAccounts, ['a@example.com', 'b@example.com']);
  const status = await sched.runAll();
  const archived = sentAccounts.filter((_, i) => i % 2 === 1); // each run sends get_capabilities then archive_all_chats
  assert.deepEqual(archived, ['a@example.com', 'b@example.com']);
  assert.equal(status.account, 'b@example.com');
});

test('with no account configured runAll still runs once against the default tab', async () => {
  const { sched, sent } = setup({ completion: Promise.resolve({ mode: 'incremental', listed: 1, total: 0, skipped: 1, archived: 0, failed: [], fatal_error: null }) });
  await sched.runAll();
  assert.equal(sent.filter((c) => c.action === 'archive_all_chats').length, 1);
});
