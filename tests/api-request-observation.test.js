import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiRequestObservationForSend, apiRequestObservationFromResource } from '../extension/lib/api-request-observation.js';

test('API request observation converts page timing to a clock-independent age and redacts IDs', () => {
  const observation = apiRequestObservationFromResource({
    name: 'https://chatgpt.com/backend-api/conversation/private-thread-id?token=secret',
    startTime: 25,
    duration: 80.6,
    responseStatus: 429,
    initiatorType: 'fetch',
  });

  assert.deepEqual(observation, {
    endpoint_class: 'conversation',
    request_start_page_time_ms: 25,
    duration_ms: 81,
    api_status: 429,
    initiator_type: 'fetch',
    source: 'performance_resource_timing',
  });
  const wireEvent = apiRequestObservationForSend(observation, 130.6);
  assert.deepEqual(wireEvent, {
    endpoint_class: 'conversation',
    duration_ms: 81,
    api_status: 429,
    initiator_type: 'fetch',
    source: 'performance_resource_timing',
    request_age_ms: 106,
  });
  assert.equal(JSON.stringify(wireEvent).includes('request_start_page_time_ms'), false);
  assert.equal(JSON.stringify(wireEvent).includes('private-thread-id'), false);
  assert.equal(JSON.stringify(wireEvent).includes('secret'), false);
});

test('API request observation ignores unrelated origins, static paths, and invalid timings', () => {
  const base = { startTime: 1, duration: 2, responseStatus: 200, initiatorType: 'fetch' };
  assert.equal(apiRequestObservationFromResource({ ...base, name: 'https://example.com/backend-api/conversations' }), null);
  assert.equal(apiRequestObservationFromResource({ ...base, name: 'https://chatgpt.com/assets/app.js' }), null);
  assert.equal(apiRequestObservationFromResource({ ...base, name: 'https://chatgpt.com/api/health', duration: Infinity }), null);
});

test('API request observation refuses an invalid page-relative age at send time', () => {
  const observation = { endpoint_class: 'conversation', request_start_page_time_ms: 25, duration_ms: 10 };
  assert.equal(apiRequestObservationForSend(observation, 24), null);
  assert.equal(apiRequestObservationForSend(observation, Infinity), null);
  assert.equal(apiRequestObservationForSend({ duration_ms: 10 }, 50), null);
});
