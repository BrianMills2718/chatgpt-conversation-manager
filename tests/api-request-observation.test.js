import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiRequestObservationFromResource } from '../extension/lib/api-request-observation.js';

test('API request observation keeps status and timing while redacting IDs and query strings', () => {
  const event = apiRequestObservationFromResource({
    name: 'https://chatgpt.com/backend-api/conversation/private-thread-id?token=secret',
    startTime: 25,
    duration: 80.6,
    responseStatus: 429,
    initiatorType: 'fetch',
  }, Date.parse('2026-09-29T12:00:00.000Z'));

  assert.deepEqual(event, {
    endpoint_class: 'conversation',
    request_started_at: '2026-09-29T12:00:00.025Z',
    completed_at: '2026-09-29T12:00:00.105Z',
    duration_ms: 81,
    api_status: 429,
    initiator_type: 'fetch',
    source: 'performance_resource_timing',
  });
  assert.equal(JSON.stringify(event).includes('private-thread-id'), false);
  assert.equal(JSON.stringify(event).includes('secret'), false);
});

test('API request observation ignores unrelated origins, static paths, and invalid timings', () => {
  const base = { startTime: 1, duration: 2, responseStatus: 200, initiatorType: 'fetch' };
  assert.equal(apiRequestObservationFromResource({ ...base, name: 'https://example.com/backend-api/conversations' }, 0), null);
  assert.equal(apiRequestObservationFromResource({ ...base, name: 'https://chatgpt.com/assets/app.js' }, 0), null);
  assert.equal(apiRequestObservationFromResource({ ...base, name: 'https://chatgpt.com/api/health', duration: Infinity }, 0), null);
});
