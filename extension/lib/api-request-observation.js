// Reduce a same-origin ChatGPT resource timing entry to rate-limit evidence.
// Keep paths, query strings, conversation IDs, response bodies, and headers out
// of the broker log; the endpoint class is enough to compare request mix.
export function apiRequestObservationFromResource(entry) {
  if (!entry) return null;

  let url;
  try { url = new URL(String(entry.name || ''), 'https://chatgpt.com'); }
  catch { return null; }
  if (url.origin !== 'https://chatgpt.com') return null;

  const pathname = url.pathname;
  let endpointClass;
  if (pathname === '/api/auth/session') endpointClass = 'auth_session';
  else if (/^\/backend-api\/conversation\/[^/]+/.test(pathname)) endpointClass = 'conversation';
  else if (pathname === '/backend-api/conversations') endpointClass = 'conversation_list';
  else if (pathname.startsWith('/backend-api/gizmos/')) endpointClass = 'project_sidebar';
  else if (pathname.startsWith('/backend-api/files/')) endpointClass = 'file_download';
  else if (pathname.startsWith('/backend-api/')) endpointClass = 'backend_other';
  else if (pathname.startsWith('/api/')) endpointClass = 'api_other';
  else return null;

  const startTime = Number(entry.startTime);
  const duration = Number(entry.duration);
  if (!Number.isFinite(startTime) || startTime < 0 || !Number.isFinite(duration) || duration < 0) return null;

  const rawStatus = Number(entry.responseStatus);
  const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
  const initiatorType = typeof entry.initiatorType === 'string' ? entry.initiatorType.slice(0, 32) : null;

  return {
    endpoint_class: endpointClass,
    // Internal page-relative marker. The content script converts this to an
    // elapsed age immediately before socket.send(), including any queue delay.
    request_start_page_time_ms: startTime,
    duration_ms: Math.round(duration),
    api_status: status,
    initiator_type: initiatorType,
    source: 'performance_resource_timing',
  };
}

export function apiRequestObservationForSend(observation, pageNowMs) {
  if (!observation || !Number.isFinite(pageNowMs)) return null;
  const startTime = Number(observation.request_start_page_time_ms);
  if (!Number.isFinite(startTime) || startTime < 0) return null;
  const requestAgeMs = pageNowMs - startTime;
  if (!Number.isFinite(requestAgeMs) || requestAgeMs < 0) return null;

  const wireObservation = { ...observation };
  delete wireObservation.request_start_page_time_ms;
  return { ...wireObservation, request_age_ms: Math.round(requestAgeMs) };
}
