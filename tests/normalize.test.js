import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeMessages, buildSnapshot, snapshotFingerprint } from '../extension/lib/normalize.js';

test('dedupeMessages dedupes by message_id when present', () => {
  const out = dedupeMessages([
    { message_id: 'm1', role: 'user', text: 'hi' },
    { message_id: 'm1', role: 'user', text: 'hi' },
    { message_id: 'm2', role: 'assistant', text: 'hello' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((m) => m.message_id), ['m1', 'm2']);
});

test('dedupeMessages falls back to role+text-prefix key when message_id is missing', () => {
  const out = dedupeMessages([
    { message_id: null, role: 'user', text: 'hello there' },
    { message_id: null, role: 'user', text: 'hello there' },
    { message_id: null, role: 'assistant', text: 'hello there' }, // different role, kept
  ]);
  assert.equal(out.length, 2);
});

test('dedupeMessages drops empty-text entries and preserves order', () => {
  const out = dedupeMessages([
    { message_id: 'a', role: 'user', text: '' },
    { message_id: 'b', role: 'user', text: 'first' },
    { message_id: 'c', role: 'assistant', text: 'second' },
  ]);
  assert.deepEqual(out.map((m) => m.message_id), ['b', 'c']);
});

test('buildSnapshot produces the expected shape and dedupes messages', () => {
  const snapshot = buildSnapshot(
    {
      threadId: 't1',
      title: 'Hello',
      titleSource: 'api',
      url: 'https://chatgpt.com/c/t1',
      messages: [
        { message_id: 'm1', role: 'user', text: 'hi' },
        { message_id: 'm1', role: 'user', text: 'hi' },
      ],
      captureSource: 'api',
      completenessWarning: null,
    },
    { now: () => '2026-01-01T00:00:00.000Z' }
  );
  assert.deepEqual(snapshot, {
    thread_id: 't1',
    title: 'Hello',
    title_source: 'api',
    url: 'https://chatgpt.com/c/t1',
    updated_at: '2026-01-01T00:00:00.000Z',
    capture_source: 'api',
    completeness_warning: null,
    messages: [{ message_id: 'm1', role: 'user', text: 'hi' }],
  });
});

test('snapshotFingerprint is stable across equivalent snapshots and changes when content changes', () => {
  const a = buildSnapshot(
    { threadId: 't1', title: 'X', url: 'u', messages: [{ message_id: 'm1', role: 'user', text: 'hi' }], captureSource: 'api' },
    { now: () => 'T' }
  );
  const b = buildSnapshot(
    { threadId: 't1', title: 'X', url: 'u', messages: [{ message_id: 'm1', role: 'user', text: 'hi' }], captureSource: 'api' },
    { now: () => 'DIFFERENT_TIMESTAMP' }
  );
  assert.equal(snapshotFingerprint(a), snapshotFingerprint(b)); // timestamp doesn't affect fingerprint

  const c = buildSnapshot(
    { threadId: 't1', title: 'X', url: 'u', messages: [{ message_id: 'm1', role: 'user', text: 'edited' }], captureSource: 'api' },
    { now: () => 'T' }
  );
  assert.notEqual(snapshotFingerprint(a), snapshotFingerprint(c));
});
