import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchiveStore } from '../server/archive.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-archive-test-'));
  return new ArchiveStore(dir);
}

function snap(overrides = {}) {
  return {
    thread_id: 't1',
    title: 'Hello world',
    url: 'https://chatgpt.com/c/t1',
    capture_source: 'api',
    messages: [
      { message_id: 'm1', role: 'user', text: 'hi' },
      { message_id: 'm2', role: 'assistant', text: 'hello' },
    ],
    ...overrides,
  };
}

test('archiveSnapshot writes json/md/history and a catalog entry', () => {
  const store = tempStore();
  const t = store.archiveSnapshot(snap());
  assert.equal(t.title, 'Hello world');
  assert.equal(t.message_count, 2);
  assert.equal(t.status, 'current');

  const paths = store.threadPaths('t1');
  assert.ok(fs.existsSync(paths.json));
  assert.ok(fs.existsSync(paths.md));
  assert.ok(fs.existsSync(paths.history));
  assert.equal(fs.readFileSync(paths.history, 'utf8').trim().split('\n').length, 1);
});

test('archiveSnapshot does not append a new history line when content is unchanged', () => {
  const store = tempStore();
  store.archiveSnapshot(snap());
  store.archiveSnapshot(snap()); // identical content
  const paths = store.threadPaths('t1');
  assert.equal(fs.readFileSync(paths.history, 'utf8').trim().split('\n').length, 1);
});

test('archiveSnapshot appends a new history line when content changes', () => {
  const store = tempStore();
  store.archiveSnapshot(snap());
  store.archiveSnapshot(snap({ title: 'Renamed' }));
  const paths = store.threadPaths('t1');
  assert.equal(fs.readFileSync(paths.history, 'utf8').trim().split('\n').length, 2);
});

test('assignProject then numberThread allocates sequential numbers per project/series', () => {
  const store = tempStore();
  store.archiveSnapshot(snap({ thread_id: 't1' }));
  store.archiveSnapshot(snap({ thread_id: 't2', title: 'Second' }));

  const t1 = store.numberThread('t1', { projectName: 'Paper', series: 'draft' });
  const t2 = store.numberThread('t2', { projectName: 'Paper', series: 'draft' });
  assert.equal(t1.sequence, 1);
  assert.equal(t2.sequence, 2);
  assert.equal(t1.project_id, t2.project_id);
});

test('numberThread rejects an explicit sequence already used in the same project/series', () => {
  const store = tempStore();
  store.archiveSnapshot(snap({ thread_id: 't1' }));
  store.archiveSnapshot(snap({ thread_id: 't2', title: 'Second' }));
  store.numberThread('t1', { projectName: 'Paper', series: 'draft', sequence: 1 });
  assert.throws(() => store.numberThread('t2', { projectName: 'Paper', series: 'draft', sequence: 1 }), /already used/);
});

test('numberThread requires the thread to already belong to a project', () => {
  const store = tempStore();
  store.archiveSnapshot(snap());
  assert.throws(() => store.numberThread('t1', {}), /Assign the thread to a project/);
});

test('undoLastAction reverts the most recent assignProject', () => {
  const store = tempStore();
  store.archiveSnapshot(snap());
  store.assignProject('t1', 'Alpha');
  let t = store.readCatalog().threads.t1;
  assert.equal(t.project_name, 'Alpha');

  store.assignProject('t1', 'Beta');
  t = store.readCatalog().threads.t1;
  assert.equal(t.project_name, 'Beta');

  const reverted = store.undoLastAction('t1');
  assert.equal(reverted.project_name, 'Alpha');
});

test('undoLastAction reverts a numberThread change independently of a later assignProject', () => {
  const store = tempStore();
  store.archiveSnapshot(snap());
  store.numberThread('t1', { projectName: 'Alpha', series: 'draft', sequence: 3 });
  let t = store.readCatalog().threads.t1;
  assert.equal(t.sequence, 3);

  const reverted = store.undoLastAction('t1');
  assert.equal(reverted.sequence, null);
});

test('undoLastAction throws when there is nothing left to undo', () => {
  const store = tempStore();
  store.archiveSnapshot(snap());
  assert.throws(() => store.undoLastAction('t1'), /No undoable action/);
});

test('setThreadStatus validates the enum and setThreadParent validates the target', () => {
  const store = tempStore();
  store.archiveSnapshot(snap({ thread_id: 't1' }));
  store.archiveSnapshot(snap({ thread_id: 't2', title: 'Second' }));

  assert.throws(() => store.setThreadStatus('t1', 'bogus'), /status must be one of/);
  const t = store.setThreadStatus('t1', 'superseded');
  assert.equal(t.status, 'superseded');

  assert.throws(() => store.setThreadParent('t1', 'does-not-exist'), /Unknown parent thread/);
  assert.throws(() => store.setThreadParent('t1', 't1'), /own parent/);
  const linked = store.setThreadParent('t2', 't1');
  assert.equal(linked.parent_thread_id, 't1');
});

test('search filters by project, status, thread id, and date range', () => {
  const store = tempStore();
  store.archiveSnapshot(snap({ thread_id: 't1', title: 'Measurement validity notes', messages: [{ message_id: 'm1', role: 'user', text: 'discuss measurement validity' }] }));
  store.archiveSnapshot(snap({ thread_id: 't2', title: 'Unrelated', messages: [{ message_id: 'm2', role: 'user', text: 'discuss measurement validity too' }] }));
  store.assignProject('t1', 'Paper');
  store.setThreadStatus('t2', 'abandoned');

  const byProject = store.search('measurement', { project: 'Paper' });
  assert.deepEqual(byProject.map((r) => r.thread_id), ['t1']);

  const byStatus = store.search('measurement', { status: 'abandoned' });
  assert.deepEqual(byStatus.map((r) => r.thread_id), ['t2']);

  const byThread = store.search('measurement', { threadId: 't1' });
  assert.deepEqual(byThread.map((r) => r.thread_id), ['t1']);

  const future = store.search('measurement', { since: '2999-01-01T00:00:00.000Z' });
  assert.equal(future.length, 0);
});

test('saveCheckpoint appends a checkpoint and regenerates the project wiki', () => {
  const store = tempStore();
  store.archiveSnapshot(snap());
  store.assignProject('t1', 'Paper');
  const cp = store.saveCheckpoint('t1', { summary: 'Decided on approach X.', status: 'accepted', decisions: ['Use approach X'] });
  assert.ok(cp.checkpoint_id);

  const wikiPath = path.join(store.wikiDir, 'paper.md');
  assert.ok(fs.existsSync(wikiPath));
  const wiki = fs.readFileSync(wikiPath, 'utf8');
  assert.match(wiki, /Decided on approach X\./);
  assert.match(wiki, /Use approach X/);
});

test('addTag/removeTag support a thread having many tags independent of its single primary project', () => {
  const store = tempStore();
  store.archiveSnapshot(snap());
  store.assignProject('t1', 'Paper');

  let t = store.addTag('t1', 'cross-cutting');
  assert.deepEqual(t.tags, ['cross-cutting']);
  t = store.addTag('t1', 'urgent');
  assert.deepEqual(t.tags, ['cross-cutting', 'urgent']);
  t = store.addTag('t1', 'urgent'); // dedup
  assert.deepEqual(t.tags, ['cross-cutting', 'urgent']);

  t = store.removeTag('t1', 'cross-cutting');
  assert.deepEqual(t.tags, ['urgent']);

  assert.equal(t.project_name, 'Paper'); // primary project untouched by tagging
});

test('search filters by tag', () => {
  const store = tempStore();
  store.archiveSnapshot(snap({ thread_id: 't1', title: 'Alpha notes', messages: [{ message_id: 'm1', role: 'user', text: 'discuss alpha topic' }] }));
  store.archiveSnapshot(snap({ thread_id: 't2', title: 'Beta notes', messages: [{ message_id: 'm2', role: 'user', text: 'discuss alpha topic too' }] }));
  store.addTag('t1', 'important');

  const tagged = store.search('alpha', { tag: 'important' });
  assert.deepEqual(tagged.map((r) => r.thread_id), ['t1']);

  const all = store.search('alpha');
  assert.equal(all.length, 2);
});

test('setNativeProjectRef records mirroring state for idempotent batch backfill', () => {
  const store = tempStore();
  store.archiveSnapshot(snap());
  const t = store.setNativeProjectRef('t1', 'g-p-abc123');
  assert.equal(t.native_project_ref, 'g-p-abc123');
  assert.throws(() => store.setNativeProjectRef('does-not-exist', 'g-p-x'), /Unknown archived thread/);
});
