import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTitle, cleanTitle, cleanDocumentTitle, selectTitle, isSameOriginPageAnchor } from '../extension/lib/title.js';

test('isValidTitle rejects the "Skip to content" accessibility label', () => {
  assert.equal(isValidTitle('Skip to content'), false);
  assert.equal(isValidTitle('  Skip to content  '), false);
  assert.equal(isValidTitle('SKIP TO CONTENT'), false);
});

test('isValidTitle rejects other known nav/a11y labels and empties', () => {
  assert.equal(isValidTitle('ChatGPT'), false);
  assert.equal(isValidTitle('New chat'), false);
  assert.equal(isValidTitle('Chat history'), false);
  assert.equal(isValidTitle(''), false);
  assert.equal(isValidTitle('   '), false);
  assert.equal(isValidTitle(null), false);
  assert.equal(isValidTitle(undefined), false);
});

test('isValidTitle accepts a real conversation title', () => {
  assert.equal(isValidTitle('Objective critique and advice'), true);
  assert.equal(isValidTitle('01 — Methods Review — Institutional Adaptation'), true);
});

test('cleanTitle trims and returns null for invalid values', () => {
  assert.equal(cleanTitle('  Real Title  '), 'Real Title');
  assert.equal(cleanTitle('Skip to content'), null);
});

test('cleanDocumentTitle strips ChatGPT suffix/prefix variants', () => {
  assert.equal(cleanDocumentTitle('Objective critique and advice - ChatGPT'), 'Objective critique and advice');
  assert.equal(cleanDocumentTitle('ChatGPT - Objective critique and advice'), 'Objective critique and advice');
  assert.equal(cleanDocumentTitle('Objective critique and advice — ChatGPT'), 'Objective critique and advice');
  assert.equal(cleanDocumentTitle('ChatGPT'), null);
});

test('selectTitle prefers the first valid candidate in priority order', () => {
  const result = selectTitle([
    { source: 'sidebar-current', value: 'Skip to content' }, // rejected
    { source: 'document-title', value: 'Real Title' },
    { source: 'main-h1', value: 'Ignored fallback' },
  ]);
  assert.deepEqual(result, { title: 'Real Title', source: 'document-title' });
});

test('selectTitle returns null title/source when nothing validates', () => {
  const result = selectTitle([
    { source: 'sidebar-current', value: 'Skip to content' },
    { source: 'document-title', value: '' },
  ]);
  assert.deepEqual(result, { title: null, source: null });
});

test('selectTitle handles an empty candidate list', () => {
  assert.deepEqual(selectTitle([]), { title: null, source: null });
  assert.deepEqual(selectTitle(undefined), { title: null, source: null });
});

test('isSameOriginPageAnchor identifies hash-only hrefs (the "Skip to content" bug root cause)', () => {
  assert.equal(isSameOriginPageAnchor('#main'), true);
  assert.equal(isSameOriginPageAnchor('#main-content'), true);
  assert.equal(isSameOriginPageAnchor('/c/abc123'), false);
  assert.equal(isSameOriginPageAnchor(''), false);
  assert.equal(isSameOriginPageAnchor(undefined), false);
});
