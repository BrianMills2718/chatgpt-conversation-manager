# ADR-0001: Separate API requests from broker actions in request timing

- **Status:** accepted
- **Date:** 2026-09-29

## Context

The broker previously counted logical actions as if each were one backend
request. A single ask can make several HTTP requests, and ordinary ChatGPT page
traffic shares the account's rate limit. Per-tab auto-capture also bypassed the
broker's action log. Those counts could not establish which request mix and
rate preceded a throttle.

## Decision

- Keep appending to `data/observations/request-timing.jsonl`, with new event
  shapes marked `schema_version: 2` and an `event_type`.
- Record `broker_action` events separately from `api_request` observations.
  API observations include account, endpoint class, start and completion times,
  duration, status, tab, and initiator type. Keep endpoint paths, chat IDs,
  query strings, headers, and bodies out of these events.
- Observe same-origin `/api/*` and `/backend-api/*` resources through the
  browser Resource Timing API. Record observer availability and any bounded
  queue loss so missing telemetry is visible.
- Serialize each account's broker actions through one reserved lane. A send
  that needs navigation holds one reservation across navigation and submission;
  `get_reply` keeps local DOM polling available and receives an API-check permit
  only when the account lane is free and the minimum gap has elapsed.
- Preserve old version 1 records. Consumers must branch on `schema_version`
  and `event_type` rather than treating every row as one physical request.

## Consequences

The combined timeline can reconstruct observed same-origin API request rate,
status, duration, and endpoint mix alongside broker operations and account
throttle reactions. Resource Timing does not expose response headers or bodies;
it may report a null status when the browser does not expose one. Offline
observation buffering is bounded and reports a gap on overflow. The observer
does not see requests outside the ChatGPT page's same-origin `/api/*` and
`/backend-api/*` paths.

## Wrong-when condition

The pacing decision is wrong if two concurrently started backend actions for
one reported account are logged less than the earlier reservation's
`spacing_ms_applied` apart in **two independent executions** of the
same-account concurrency test.
