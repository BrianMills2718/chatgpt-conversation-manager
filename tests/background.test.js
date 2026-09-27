// Runs the real extension/background.js against a fake `chrome` + `fetch`,
// driving it only through the Chrome events it listens to.
//
// Why these cases (2026-09-27): the auto-reload's one real self-reload in
// Brian's Chrome (2026-09-26 21:21Z) left the extension with no registered
// service worker, and from then on nothing checked /health: 0.7.2-0.7.5 all
// sat on disk unloaded. The minute alarm was the only trigger, so a missing or
// idle worker failed silently. Open tabs keep running and reconnecting, so a
// tab ping is a second trigger (and a liveness probe the broker can report).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

function event() {
  const listeners = [];
  return { listeners, addListener: (fn) => listeners.push(fn), fire: (...args) => listeners.map((fn) => fn(...args)) };
}

// `alarms` seeds chrome.alarms (as persisted across a worker restart);
// `local` seeds chrome.storage.local (it survives chrome.runtime.reload()).
function loadWorker({ running = '0.7.6', onDisk = '0.7.6', alarms = {}, local = {}, now = 1_000_000 } = {}) {
  const calls = { reload: 0, create: [], fetch: [], warn: [] };
  const store = { ...local };
  const onAlarm = event(), onInstalled = event(), onStartup = event(), onMessage = event();
  const chrome = {
    runtime: {
      getManifest: () => ({ version: running }),
      reload: () => { calls.reload++; },
      onInstalled, onStartup, onMessage,
    },
    alarms: {
      get: async (name) => alarms[name],
      create: async (name, info) => { calls.create.push(name); alarms[name] = { name, ...info }; },
      onAlarm,
    },
    storage: {
      sync: { get: async (defaults) => ({ ...defaults }) },
      local: {
        get: async (defaults) => ({ ...defaults, ...store }),
        set: async (items) => { Object.assign(store, items); },
      },
    },
    tabs: { query: async () => [] },
    scripting: { executeScript: async () => {} },
  };
  const fetch = async (url) => { calls.fetch.push(String(url)); return { ok: true, json: async () => ({ ok: true, extension_version: onDisk }) }; };
  const console = { info() {}, log() {}, warn: (m) => calls.warn.push(m), error() {} };
  const DateShim = class extends Date { static now() { return now; } };
  vm.runInNewContext(SOURCE, { chrome, fetch, console, URL, Date: DateShim, setTimeout, Promise });
  return { calls, store, alarms, onAlarm, onInstalled, onStartup, onMessage };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('a worker restart keeps the existing minute alarm instead of pushing it back', async () => {
  const w = loadWorker({ alarms: { 'ccm-update-check': { name: 'ccm-update-check', periodInMinutes: 1 } } });
  await settle();
  assert.deepEqual(w.calls.create, [], 'recreating on every worker start resets the countdown, so a worker woken more often than once a minute never checks');
});

test('a worker that finds its alarm gone (cleared by the update) creates it', async () => {
  const w = loadWorker();
  await settle();
  assert.deepEqual(w.calls.create, ['ccm-update-check']);
  assert.equal(w.alarms['ccm-update-check'].periodInMinutes, 1);
});

test('a ping from a ChatGPT tab gets an answer and runs the update check', async () => {
  const w = loadWorker({ running: '0.7.6', onDisk: '0.7.7' });
  let reply;
  w.onMessage.fire({ type: 'ccm-update-check' }, { tab: { id: 7 } }, (r) => { reply = r; });
  await settle();
  assert.deepEqual({ ...reply }, { alive: true, version: '0.7.6' }); // copied out of the vm realm
  assert.equal(w.calls.fetch.length, 1);
  assert.match(w.calls.fetch[0], /^http:\/\/localhost:8787\/health$/);
  assert.equal(w.calls.reload, 1);
});

test('browser startup runs the update check without waiting for the alarm', async () => {
  const w = loadWorker({ running: '0.7.6', onDisk: '0.7.7' });
  assert.equal(w.onStartup.listeners.length, 1, 'no runtime.onStartup listener');
  w.onStartup.fire();
  await settle();
  assert.equal(w.calls.reload, 1);
});

test('the minute alarm reloads when the disk version differs, and not when it matches', async () => {
  const stale = loadWorker({ running: '0.7.5', onDisk: '0.7.6' });
  stale.onAlarm.fire({ name: 'ccm-update-check' });
  await settle();
  assert.equal(stale.calls.reload, 1);

  const current = loadWorker({ running: '0.7.6', onDisk: '0.7.6' });
  current.onAlarm.fire({ name: 'ccm-update-check' });
  await settle();
  assert.equal(current.calls.reload, 0);
});

test('a reload that did not take is not retried within five minutes (no reload loop)', async () => {
  // Same disk/running mismatch persists after our own reload one minute ago,
  // e.g. the broker is reading a different checkout's manifest than Chrome loads.
  const w = loadWorker({ running: '0.7.6', onDisk: '0.7.7', now: 1_000_000, local: { lastReloadAt: 1_000_000 - 60_000 } });
  w.onAlarm.fire({ name: 'ccm-update-check' });
  w.onMessage.fire({ type: 'ccm-update-check' }, { tab: { id: 1 } }, () => {});
  await settle();
  assert.equal(w.calls.reload, 0);
  assert.ok(w.calls.warn.some((m) => /not reloading again/.test(m)), JSON.stringify(w.calls.warn));

  const later = loadWorker({ running: '0.7.6', onDisk: '0.7.7', now: 1_000_000, local: { lastReloadAt: 1_000_000 - 6 * 60_000 } });
  later.onAlarm.fire({ name: 'ccm-update-check' });
  await settle();
  assert.equal(later.calls.reload, 1);
  assert.equal(later.store.lastReloadAt, 1_000_000, 'the reload time must be stored before reloading');
});
