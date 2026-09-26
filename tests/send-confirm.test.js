import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendEvidence, sendEvidenceFromCounts } from '../extension/lib/send-confirm.js';

const prompt = 'Review this diff for correctness and report every bug you find.';

// The observed hidden-tab case (2026-09-25/26): Send was clicked, the composer
// still showed the prompt, but ChatGPT had received it. The old check looked
// only at the composer and reported a failed send.
test('a hidden tab whose composer never cleared is confirmed by the new chat id ChatGPT assigned', () => {
  assert.equal(sendEvidence({ composerText: prompt, threadRawBefore: null, threadRawNow: 'WEB:1234', domBefore: 0, domMessages: [], expected: prompt }), 'thread_assigned');
});

test('a hidden tab whose composer never cleared is confirmed by its own user turn appearing in the thread', () => {
  const domMessages = [
    { role: 'user', text: 'earlier question' },
    { role: 'assistant', text: 'earlier answer' },
    { role: 'user', text: `  Review this diff for\ncorrectness and report every bug you find.` },
  ];
  assert.equal(sendEvidence({ composerText: prompt, threadRawBefore: 't-1', threadRawNow: 't-1', domBefore: 2, domMessages, expected: prompt }), 'user_turn_rendered');
});

test('an earlier identical user message does not count as evidence for this send', () => {
  const domMessages = [{ role: 'user', text: prompt }, { role: 'assistant', text: 'answer' }];
  assert.equal(sendEvidence({ composerText: prompt, threadRawBefore: 't-1', threadRawNow: 't-1', domBefore: 2, domMessages, expected: prompt }), null);
});

test('a cleared composer is still sufficient evidence (the visible-tab case)', () => {
  assert.equal(sendEvidence({ composerText: '  \n', threadRawBefore: 't-1', threadRawNow: 't-1', domBefore: 0, domMessages: [], expected: prompt }), 'composer_cleared');
});

test('no observable consequence yet is unconfirmed (null), not a failure', () => {
  assert.equal(sendEvidence({ composerText: prompt, threadRawBefore: 't-1', threadRawNow: 't-1', domBefore: 0, domMessages: [], expected: prompt }), null);
});

test('the server-side message count confirms a send only when it grew', () => {
  assert.equal(sendEvidenceFromCounts(5, 4), 'server_turn');
  assert.equal(sendEvidenceFromCounts(4, 4), null);
  assert.equal(sendEvidenceFromCounts(undefined, 4), null);
});
