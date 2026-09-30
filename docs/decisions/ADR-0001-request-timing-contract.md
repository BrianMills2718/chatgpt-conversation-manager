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
- Record automatic account choices as a third schema-version-2 event type,
  `account_route`. It includes a `route_id`, selection rule, selected account,
  and each ranked candidate's projected start delay, pacing gap, pending asks,
  and whether an idle agent tab was found (`null` means the candidate was not
  probed after an earlier candidate was selected). Copy `route_id` to the
  resulting bridge ask outcome so the decision and outcome can be joined. Do
  not record prompt text or conversation identifiers in the routing event.
- Give each broker ask a random `ask_id` and copy it to the ask's
  `broker_action` events and its `bridge-events.jsonl` outcome. This is an
  optional additive field on existing event shapes; older rows remain valid
  and unjoined. Keep `route_id` for the automatic route-decision join.
- Extend the offline report to join broker actions to an ask outcome only when
  exactly one outcome has that `ask_id`. Report rate-limited actions and
  incomplete, duplicate, or account-mismatched joins as aggregate counts; do
  not emit raw `ask_id` values.
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
status, duration, and endpoint mix alongside broker operations, account-route
choices, ask outcomes, and throttle reactions. `account_route`'s projected
start is a scheduler estimate, not a ChatGPT quota counter or promise of the
global maximum. Resource Timing does not expose response headers or bodies; it
may report a null status when the browser does not expose one. Offline
observation buffering is bounded and reports a gap on overflow. The observer
does not see requests outside the ChatGPT page's same-origin `/api/*` and
`/backend-api/*` paths. Resource Timing observations are measurement-only;
only 429s surfaced through broker operations currently update the adaptive
pacer. `ask_id` links broker actions to their ask outcome; it does not assign
passive page requests to asks, so traffic from ordinary page activity remains
separate. This avoids counting one broker request twice, but means a throttle
seen only in ordinary page activity does not steer the router.

## Wrong-when condition

The pacing decision is wrong if two concurrently started backend actions for
one reported account are logged less than the earlier reservation's
`spacing_ms_applied` apart in **two independent executions** of the
same-account concurrency test. The routing decision is wrong if, in two
independent controlled executions with multiple idle identified accounts, the
selected account has a later `projected_start_in_ms` than another candidate
whose `idle_agent_tab` is `true`.
Ask attribution is wrong if the synthetic ask-level 429 test fails to join its
rate-limited broker action to exactly one outcome, or if the report exposes a
raw ask identifier.
