import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

// Scheduled incremental backup. Each run: make sure a chatgpt.com tab is
// connected (optionally opening one), ask it to archive only new/changed
// conversations, wait for completion, and record the outcome in
// sync-status.json. Failures are recorded and logged, never swallowed.
export class SyncScheduler {
  constructor({ archive, dispatch, connectionCount, waitForBulkComplete, statusPath, openCommand = null, syncAccount = null, connectWaitMs = 90000, runTimeoutMs = 12 * 60 * 60 * 1000, log = console }) {
    Object.assign(this, { archive, dispatch, connectionCount, waitForBulkComplete, statusPath, openCommand, syncAccount, connectWaitMs, runTimeoutMs, log });
    this.running = null;
    this.runningAccount = null;
    this.timer = null;
  }

  readStatus() {
    try { return JSON.parse(fs.readFileSync(this.statusPath, 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  }

  writeStatus(patch) {
    const next = { ...this.readStatus(), ...patch };
    fs.mkdirSync(path.dirname(this.statusPath), { recursive: true });
    const tmp = `${this.statusPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, this.statusPath);
    return next;
  }

  knownThreads() {
    const known = {};
    for (const [id, t] of Object.entries(this.archive.readCatalog().threads || {})) {
      if (t.last_captured_at) known[id] = t.last_captured_at;
    }
    return known;
  }

  async ensureConnected(account = this.syncAccount) {
    if (this.connectionCount(account) > 0) return;
    if (!this.openCommand) {
      const target = account ? ` for ${account}` : '';
      throw new Error(`No chatgpt.com tab is connected${target} and SYNC_OPEN_CHATGPT_CMD is not set.`);
    }
    this.log.log(`[sync] no tab connected; running SYNC_OPEN_CHATGPT_CMD`);
    await new Promise((resolve) => execFile('/bin/sh', ['-c', this.openCommand], (err) => {
      if (err) this.log.error(`[sync] open command failed: ${err.message}`);
      resolve();
    }));
    const deadline = Date.now() + this.connectWaitMs;
    while (Date.now() < deadline) {
      if (this.connectionCount(account) > 0) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`No chatgpt.com tab connected within ${Math.round(this.connectWaitMs / 1000)}s of opening ChatGPT (is Chrome signed in and the extension enabled?).`);
  }

  runOnce({ account = this.syncAccount } = {}) {
    const normalizedAccount = account ? String(account).trim().toLowerCase() : null;
    if (this.running) {
      if (this.runningAccount !== normalizedAccount) {
        return Promise.reject(new Error('A bulk archive is already running for a different account.'));
      }
      return this.running;
    }
    this.runningAccount = normalizedAccount;
    this.running = this.#run(account).finally(() => { this.running = null; this.runningAccount = null; });
    return this.running;
  }

  async #run(account = this.syncAccount) {
    const startedAt = new Date().toISOString();
    this.writeStatus({ last_attempt_at: startedAt, in_progress: true, account: account || null });
    try {
      await this.ensureConnected(account);
      // An extension still running pre-0.4 code ignores `known` and would
      // re-fetch every conversation at full speed, so refuse to start with it.
      let caps = null;
      try { caps = await this.dispatch({ action: 'get_capabilities' }, account); } catch (err) { caps = { error: err.message }; }
      if (!caps?.incremental_archive) {
        throw new Error(`Chrome extension is running old code (${caps?.error || 'no incremental support'}); reload it at chrome://extensions and refresh the ChatGPT tab.`);
      }
      const completion = this.waitForBulkComplete(this.runTimeoutMs);
      // If the dispatch below throws (e.g. a bulk archive is already running),
      // nothing awaits this promise; its timeout rejection would then be an
      // unhandled rejection, which exits Node. That killed the broker on
      // 2026-09-14, two hours after a refused run, stopping the backlog.
      completion.catch(() => {});
      await this.dispatch({ action: 'archive_all_chats', known: this.knownThreads() }, account);
      const result = await completion;
      if (result.fatal_error) {
        const error = new Error(`extension reported: ${result.fatal_error}`);
        if (Number.isInteger(result.fatal_error_status)) error.status = result.fatal_error_status;
        if (Number.isFinite(result.fatal_error_retry_after_ms)) error.retryAfterMs = result.fatal_error_retry_after_ms;
        throw error;
      }
      const summary = { account: account || null, mode: result.mode, listed: result.listed, fetched: result.total, skipped: result.skipped, archived: result.archived, failed: result.failed?.length || 0, pacing: result.pacing || null };
      if (summary.failed > 0) {
        this.log.error(`[sync] completed with ${summary.failed} failed conversations`);
      }
      this.log.log(`[sync] ok: ${JSON.stringify(summary)}`);
      return this.writeStatus({ in_progress: false, last_success_at: new Date().toISOString(), last_result: summary, last_error: null, last_error_status: null, last_error_retry_after_ms: null, failed_threads: result.failed || [] });
    } catch (err) {
      this.log.error(`[sync] FAILED: ${err.message}`);
      return this.writeStatus({
        in_progress: false,
        last_error: err.message,
        last_error_at: new Date().toISOString(),
        last_error_status: Number.isInteger(err.status) ? err.status : null,
        last_error_retry_after_ms: Number.isFinite(err.retryAfterMs) && err.retryAfterMs >= 0 ? err.retryAfterMs : null,
      });
    }
  }

  // Retry ordinary failures sooner than the normal interval, but give a
  // rate-limited account at least its normal interval or the server's
  // Retry-After, whichever is longer.
  static nextDelayMs(status, intervalMs, retryMs = 30 * 60 * 1000) {
    const failed = status?.last_error && (!status.last_success_at || status.last_error_at > status.last_success_at);
    if (!failed) return intervalMs;
    if (status.last_error_status === 429) {
      const retryAfterMs = Number.isFinite(status.last_error_retry_after_ms) ? Math.max(0, status.last_error_retry_after_ms) : 0;
      return Math.max(intervalMs, retryAfterMs);
    }
    return Math.min(intervalMs, retryMs);
  }

  static startupDelayMs(status, nowMs = Date.now(), firstRunMs = 60 * 1000) {
    const nextRunMs = Date.parse(status?.next_run_at || '');
    if (!Number.isFinite(nextRunMs) || nextRunMs <= nowMs) return firstRunMs;
    return Math.max(firstRunMs, nextRunMs - nowMs);
  }

  start(intervalMs, { firstRunMs = 60 * 1000 } = {}) {
    const previousStatus = this.readStatus();
    const initialDelayMs = SyncScheduler.startupDelayMs(previousStatus, Date.now(), firstRunMs);
    // Clear a stale in_progress flag left by a server that died mid-run.
    this.writeStatus({ in_progress: false, interval_minutes: Math.round(intervalMs / 60000) });
    const scheduleAt = (runAtMs) => {
      const delay = Math.max(0, runAtMs - Date.now());
      this.timer = setTimeout(async () => {
        // Node clamps longer setTimeout delays to 1 ms. A long server-provided
        // Retry-After must stay a long wait, including after a broker restart.
        if (Date.now() < runAtMs) {
          scheduleAt(runAtMs);
          return;
        }
        const status = await this.runOnce();
        const next = SyncScheduler.nextDelayMs(status, intervalMs);
        const nextRunAtMs = Date.now() + next;
        this.writeStatus({ next_run_at: new Date(nextRunAtMs).toISOString() });
        scheduleAt(nextRunAtMs);
      }, Math.min(delay, MAX_TIMER_DELAY_MS));
    };
    const firstRunAtMs = Date.now() + initialDelayMs;
    this.writeStatus({ next_run_at: new Date(firstRunAtMs).toISOString() });
    scheduleAt(firstRunAtMs);
    return this;
  }
}
