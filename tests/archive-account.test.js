import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchiveStore } from '../server/archive.js';

const store = () => new ArchiveStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-account-')));
const snap = () => ({ thread_id: 't1', title: 'T', messages: [{ message_id: 'm1', role: 'user', text: 'hi' }] });
const raw = (s) => JSON.parse(fs.readFileSync(s.threadPaths('t1').json, 'utf8'));

test('account is stamped in the raw JSON and the catalog', () => {
  const s = store();
  const t = s.archiveSnapshot(snap(), { account: 'a@x.com' });
  assert.equal(t.account, 'a@x.com');
  assert.deepEqual(t.accounts_seen, ['a@x.com']);
  assert.equal(raw(s).capture_account, 'a@x.com');
});

test('account is provenance, not content: it does not change the content hash', () => {
  const s1 = store(), s2 = store();
  const h1 = s1.archiveSnapshot(snap(), { account: 'a@x.com' }).content_hash;
  const h2 = s2.archiveSnapshot(snap(), { account: 'b@x.com' }).content_hash;
  assert.equal(h1, h2);
});

test('an old unstamped capture gets stamped on the next capture even if content is unchanged', () => {
  const s = store();
  const t0 = s.archiveSnapshot(snap());
  assert.equal(t0.account, null);
  assert.equal(raw(s).capture_account, null);
  const t1 = s.archiveSnapshot(snap(), { account: 'a@x.com' });
  assert.equal(t1.account, 'a@x.com');
  assert.equal(raw(s).capture_account, 'a@x.com');
});

test('a thread seen from two accounts is flagged, not silently overwritten', () => {
  const s = store();
  s.archiveSnapshot(snap(), { account: 'a@x.com' });
  const t = s.archiveSnapshot(snap(), { account: 'b@x.com' });
  assert.equal(t.account, 'a@x.com');
  assert.deepEqual(t.accounts_seen, ['a@x.com', 'b@x.com']);
  assert.equal(t.account_conflict, true);
});

test('no account given leaves account null and never guesses', () => {
  const s = store();
  assert.equal(s.archiveSnapshot(snap()).account, null);
});
