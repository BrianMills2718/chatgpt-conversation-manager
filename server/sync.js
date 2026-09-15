import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Scheduled incremental backup. Each run: make sure a chatgpt.com tab is
// connected (optionally opening one), ask it to archive only new/changed
// conversations, wait for completion, and record the outcome in
// sync-status.json. Failures are recorded and logged, never swallowed.
export class SyncScheduler {
  constructor({ archive, dispatch, connectionCount, waitForBulkComplete, statusPath, openCommand = null, connectWaitMs = 90000, runTimeoutMs = 2 * 60 * 60 * 1000, log = console }) {
    Object.assign(this, { archive, dispatch, connectionCount, waitForBulkComplete, statusPath, openCommand, connectWaitMs, runTimeoutMs, log });
    this.running = null;
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

  async ensureConnected() {
    if (this.connectionCount() > 0) return;
    if (!this.openCommand) throw new Error('No chatgpt.com tab is connected and SYNC_OPEN_CHATGPT_CMD is not set.');
    this.log.log(`[sync] no tab connected; running SYNC_OPEN_CHATGPT_CMD`);
    await new Promise((resolve) => execFile('/bin/sh', ['-c', this.openCommand], (err) => {
      if (err) this.log.error(`[sync] open command failed: ${err.message}`);
      resolve();
    }));
    const deadline = Date.now() + this.connectWaitMs;
    while (Date.now() < deadline) {
      if (this.connectionCount() > 0) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`No chatgpt.com tab connected within ${Math.round(this.connectWaitMs / 1000)}s of opening ChatGPT (is Chrome signed in and the extension enabled?).`);
  }

  runOnce() {
    if (this.running) return this.running;
    this.running = this.#run().finally(() => { this.running = null; });
    return this.running;
  }

  async #run() {
    const startedAt = new Date().toISOString();
    this.writeStatus({ last_attempt_at: startedAt, in_progress: true });
    try {
      await this.ensureConnected();
      const completion = this.waitForBulkComplete(this.runTimeoutMs);
      await this.dispatch({ action: 'archive_all_chats', known: this.knownThreads() });
      const result = await completion;
      if (result.fatal_error) throw new Error(`extension reported: ${result.fatal_error}`);
      const summary = { mode: result.mode, listed: result.listed, fetched: result.total, skipped: result.skipped, archived: result.archived, failed: result.failed?.length || 0 };
      if (summary.failed > 0) {
        this.log.error(`[sync] completed with ${summary.failed} failed conversations`);
      }
      this.log.log(`[sync] ok: ${JSON.stringify(summary)}`);
      return this.writeStatus({ in_progress: false, last_success_at: new Date().toISOString(), last_result: summary, last_error: null, failed_threads: result.failed || [] });
    } catch (err) {
      this.log.error(`[sync] FAILED: ${err.message}`);
      return this.writeStatus({ in_progress: false, last_error: err.message, last_error_at: new Date().toISOString() });
    }
  }

  start(intervalMs) {
    // Clear a stale in_progress flag left by a server that died mid-run.
    this.writeStatus({ in_progress: false, interval_minutes: Math.round(intervalMs / 60000) });
    const tick = () => { this.runOnce(); };
    setTimeout(tick, 60 * 1000); // first run shortly after startup
    this.timer = setInterval(tick, intervalMs);
    return this;
  }
}
