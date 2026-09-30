# Long-Running Goal: Consolidate ChatGPT orchestration + activate multi-account

## Goal

**Mission:** Stop maintaining two competing ChatGPT-dispatch mechanisms (an
ad-hoc raw-`ask_chatgpt` loop vs. the more mature `weekly_chatgpt_supervisor.py`),
extract the latter's proven dispatch robustness into one shared client, prove
real multi-account dispatch works, fix the broker's rate-limit pacer so accounts are properly
independent, and document the per-person deployment shape that lets Brian
hand this to a colleague. Brian expanded the goal on 2026-09-29 to include
adaptive selection among connected ChatGPT accounts for unpinned new asks,
using each account's observed pacing and queued work. Full plan and rationale:
`/home/brian/.claude/plans/async-snuggling-thompson.md` (approved by Brian,
2026-09-25).

**Execution profile:** `continuous-coordinated`

Two repos are involved (`chatgpt-conversation-manager-v0.2` and
`weekly-plans`) with dependent phases: Phase 2 and 3 both depend on Phase 1's
extracted client existing first.

**Stage and investment boundary:** PoC-to-tool hardening on Brian's own
personal infrastructure, not a release/migration/destructive action. No
formal budget given; revalidate per the Loop Bounds below rather than a token
count.

**Canonical example:** `dispatch_many([{"text": "...", "account": "A"}, {"text": "...", "account": "B"}])`
sends two prompts to two different, simultaneously-connected real ChatGPT
accounts and returns both real replies, verified by reading each conversation
transcript back directly (not trusting a reported success status) — the
capability that failed all of the prior session (2026-09-25) due to browser
focus contention and a since-fixed `fresh_tab` PATH bug. (Correction 2026-09-26: the "focus contention" failures were false "composer did not clear" send failures in hidden tabs — the prompts were sent; see CHANGELOG v0.7.2.)

**Forbidden substitutes:** A single-account dispatch relabeled as "multi-account
verified." A mocked/stubbed broker response standing in for a real ChatGPT
reply for C3/C4. Claiming Phase 3 done from the pacer code change alone without
an actual live two-account concurrent dispatch and inspection of the persisted
pacer state file showing two independent entries. C6's synthetic 429 is only
evidence for the routing algorithm; it is not live quota or throughput evidence.

**Repository / working scope:** Primary: `weekly-plans` (Phase 1 — new
`scripts/chatgpt_dispatch_client.py` module extracted from
`weekly_chatgpt_supervisor.py`'s proven dispatch logic, plus Phase 2's
review-sweep script). Secondary: `chatgpt-conversation-manager-v0.2` (Phase 3's
server pacer fix, Phase 4's README addition — no client code lives here; see
Increment 1 resolution below for why). Each repo's own `AGENTS.md`/`CLAUDE.md`
governs while working in it.

## Boundaries

- In scope: the shared dispatch client, the review-sweep's dispatch mechanism,
  the broker's rate-limit pacer, connecting a second real ChatGPT account,
  documenting per-person deployment, and locally routing unpinned new asks to
  the connected account with the earliest projected start under its learned
  pacing gap and current queue.
- Out of scope: any centralized/hosted broker (Brian's explicit call,
  2026-09-25); any new "router" that decides ChatGPT-vs-Claude (Decision 0014
  governs that, reused as-is); `weekly_chatgpt_supervisor.py`'s task-profile
  model itself (`autonomous`/`review_gated`/`hands_on`/`human_only` stays
  exactly as-is — only its dispatch internals move to the shared client).
- Writes allowed: `chatgpt-conversation-manager-v0.2/{GOAL.md,server/index.js,README.md,CLAUDE.md,docs/decisions/ADR-0001-request-timing-contract.md,scripts/bridge-observation-report.js,extension/content.js,extension/manifest.json,extension/lib/api-request-observation.js,tests/api-request-observation.test.js,tests/server.test.js}`,
  `weekly-plans/scripts/{weekly_chatgpt_supervisor.py,chatgpt_dispatch_client.py,
  test_chatgpt_dispatch_client.py,review_sweep.py}`, and each affected repo's
  own `investigations/chatgpt-review-sweep-manifest.{tsv,md}`.
- Read-only or externally owned: the two DIGIMON/OntoCanon repos the
  review-sweep targets (only their manifest files are written by this goal;
  actual file fixes found by future sweep runs go through each repo's own
  worktree+PR+merge discipline, unchanged from tonight's established pattern).
- Irreversible actions requiring authorization: none anticipated. If one
  appears (e.g. deleting `data-account2`/`data-account3` — unexplained
  pre-existing directories found during Phase 1 investigation, not yet
  understood), stop and report rather than acting.

## Acceptance Checks

| ID | Criterion | Evidence to report |
| --- | --- | --- |
| C1 | Shared dispatch client extracted and working | `weekly_chatgpt_supervisor.py`'s existing test suite (11 tests per its design doc) passes after refactoring it to call the new client |
| C2 | Review-sweep uses the shared client, not the old raw-`ask_chatgpt`+focus-lock pattern | A real sweep run against currently-`pending` manifest rows in either target repo, reaching real ChatGPT replies without any manual PowerShell foreground-locking |
| C3 | Real two-account concurrent dispatch | Two real replies from two distinct connected accounts in one `dispatch_many` call, both transcripts read back directly |
| C4 | Pacer is per-account | Persisted pacer state file shows two independent account-keyed entries after C3's run, not one shared global entry |
| C5 | Per-person deployment documented | The written README/CLAUDE.md section accurately describes what C1-C4 actually built, not an aspirational future state |
| C6 | Adaptive account routing responds to account cooldowns | A broker-level test feeds a synthetic 429 to account A, verifies A's learned gap widens, then verifies an unpinned new ask selects idle account B with the earlier projected start; the route decision is joined to its ask outcome by `route_id` |
| C7 | API timing evidence survives browser clock skew and delayed delivery | The extension sends page-relative request age at socket-send time; the broker reconstructs start/completion from that age and its receipt clocks, and rolling request counts use request-start times. Synthetic tests prove skewed/legacy wall timestamps are not trusted and buffered events retain their original timing window |
| C8 | Broker-visible throttles are attributable to individual asks | Each ask's broker actions and bridge outcome share one random `ask_id`; the offline report joins only to one unique outcome, reports rate-limited action counts plus missing/duplicate/account-mismatch counts, and never prints ask IDs. Legacy rows remain unjoined; passive `api_request` rows remain unassigned. A synthetic ask-level 429 test proves the join without live ChatGPT traffic |

C6 proves the scheduler behavior using controlled browser fakes. It does not
prove ChatGPT's hidden account limits or claim that any fixed routing policy
achieves a global throughput maximum. Live quota estimates must come from
observed traffic and 429s, and are limited to activity visible in connected
browser pages.

### Exploratory readout of existing traffic (offline)

- **Claim:** all stored `api_request` rows can describe HTTP request outcomes.
  Legacy schema-version-2 rows support request rates only when clock-offset
  checks pass; schema-version-3 rows use broker receipt time minus
  page-relative request age and do not need cross-clock correction. Both
  populations cover only activity visible in connected browser pages.
- **Decision:** determine whether these historical rows support a descriptive
  per-account request-rate range or only counts/statuses plus a need for future
  observations. They do not directly measure completed prompts or task
  throughput because `api_request` rows remain unassigned to asks; the new
  `ask_id` join covers broker actions and ask outcomes, not all page requests.
- **Unit and population:** one `event_type=api_request` row in
  `data/observations/request-timing.jsonl`; include all endpoint classes and
  report each separately. Exclude `broker_action` rows from API-request counts
  to avoid double-counting, while retaining them for separate action outcomes.
- **Validity check:** for legacy schema-version-2 rows, compare broker log time
  `ts` with page `completed_at`. Report each tab's median offset, median
  absolute deviation, and first-half versus second-half offset shift. Correct
  per-tab page timestamps by that tab's median offset only when the deviation
  is at most 1 second and the half-to-half shift at most 2 seconds; these
  bounds allow the 200 ms extension flush interval plus local scheduling and
  transport variation while rejecting unstable clocks or long buffering.
  Otherwise do not combine that tab's start times across tabs. For
  schema-version-3 rows, use the logged request-start time directly and retain
  the `timing_basis`; the timestamp is reconstructed from the broker's receipt
  clock and the page-relative age measured immediately before socket send.
- **Readout:** per account, `agent_tab` state, and endpoint class, report event
  count, status mix, 429 share, and observed start-to-start request gaps only
  for timing-valid rows. Embedded rolling counts are best-effort counts of
  observations already received, retained for requests up to five minutes old
  with a ten-minute timestamp cache covering the preceding five-minute window;
  older observations keep their raw timing/status but have null rolling counts.
  Recompute historical windows from the event rows, accounting for telemetry
  gaps.
  Treat missing status and invalid/unstable timing separately. No
  causal, prompt-rate, hidden-quota, or global-maximum claim follows from this
  retrospective analysis.
- `node scripts/bridge-observation-report.js` reads both observation logs,
  reports API requests by account, agent-tab state, and endpoint, keeps broker
  actions separate, pseudonymizes account, tab, and conversation identifiers
  within the report, reduces source paths to filenames, joins automatic route
  decisions to ask outcomes by `route_id`, and joins broker actions to ask
  outcomes by `ask_id` when the outcome is unique. It reports missing and
  mismatched joins without exposing raw ask IDs. It does not assign passive
  page requests to individual asks. Request rows do not include HTTP method,
  so `conversation` endpoint 429s cannot be classified as prompt sends versus
  reads.
- **Boundary:** observation does not send agent prompts or run scheduled archive
  sync. Connected ChatGPT tabs still make real API requests, which are recorded
  by the observer and count against those accounts. Do not treat passive page
  requests as routed ask volume or generate extra asks solely for measurement
  without Brian's explicit authorization. If timing validity fails, stop at
  counts and status mix and use schema-version-3 observations from connected
  pages only while the broker is running.

## Increments

1. **Resolved 2026-09-25.** Two open unknowns from Phase 1 entry:
   (a) *Language mismatch:* `chatgpt-conversation-manager-v0.2` is pure
   Node.js — it owns only the broker/REST API (`/api/ask`, `/api/thread/:id`,
   `/api/read/:thread`), confirmed via repo search (no Python files anywhere).
   The plan's proposed `client/dispatch.py` inside that repo was wrong.
   Resolution: the shared dispatch client stays Python and lives in
   `weekly-plans` (`scripts/chatgpt_dispatch_client.py`), because that's
   where the proven `SentWithoutReply`/poll-recovery/`ThreadPoolExecutor`
   logic already exists (`weekly_chatgpt_supervisor.py:457-533`) — extracting
   it in place reuses proven code instead of porting it into a new language.
   The Node repo's only remaining goal-scope work is the Phase 3 pacer fix
   and Phase 4 docs, both server-side, no client module needed there.
   (b) *`data-account2`/`data-account3`:* inspected directly — both are
   untracked (never in `git log`, gitignored via `data-account*` in
   `.gitignore`), empty (`catalog.json` has zero threads/projects/actions,
   `raw/chats/` and `wiki/` subdirs empty), dated 2026-08-20, and not
   referenced anywhere in `server/*.js` or `extension/*.js` (grep for
   `data-account`/`ACCOUNT_DATA`/`dataDirFor` returns nothing). The current
   `.env` only configures a single `ARCHIVE_DIR=./data`. Conclusion: these are
   stale, abandoned, disconnected scaffolding — **not** evidence of prior
   multi-account testing. Phase 3's premise stands unchanged: real
   two-account dispatch has never been tried. Left in place untouched per
   the Boundaries section (no deletion without asking).
2. Phase 1: shared dispatch mechanism extracted; `weekly_chatgpt_supervisor.py`
   refactored to use it; its test suite still passes (C1).
3. Phase 2: review-sweep rebuilt on the shared mechanism (C2).
4. Phase 3: pacer made per-account; second real account connected; live
   two-account concurrent dispatch proven (C3, C4).
5. Phase 4: per-person deployment documented (C5).
6. **Added 2026-09-29 at Brian's direction.** Phase 5: for unpinned new asks,
   choose the connected account with the earliest projected start based on its
   learned pacer gap, in-flight asks, and pending automatic assignments. Keep
   explicit-account requests pinned and leave thread-targeted requests on the
   existing path. Record the candidate estimates and selected account, then
   link the resulting ask outcome (C6).
7. **Added 2026-09-30 while continuing the measurement work.** Phase 6:
   replace extension wall-clock API timestamps with page-relative request age,
   reconstruct timings against broker receipt clocks, count buffered requests
   by their start time, and version the observation record (C7). This improves
   attribution but still cannot reveal ChatGPT's hidden quotas or prove a
   global throughput maximum.

## Loop Bounds

- No-progress stop: after 3 materially different attempts at the same
  reproduced blocker (e.g. the Chrome focus-contention problem from the prior
  session, or a broker-side race) produce no new evidence, stop and report
  the blocker plus the exact resume event, rather than continuing to retry.
- Finite turn/attempt bound: each phase gets its own bounded attempt budget;
  do not silently keep expanding scope within a phase past what its
  acceptance check requires.
- Strategy revalidation: after three substantive increments, roughly four
  hours of active work, or a scope/roadmap change from Brian — compare
  user-visible progress (a real capability proven) against enabling/process
  work (refactoring, doc-writing) and report which. If the plan no longer
  represents the shortest path to "share this with the team," stop and
  return control for replanning rather than continuing on the original path.
- Exact blocked resume event: if blocked on something only Brian can resolve
  (e.g. a second real ChatGPT account credential, or a deployment-topology
  reversal), name that exact event in the closeout and stop there — do not
  poll or retry it.

<!-- goal-authority-reversion:v1:start -->
```yaml
schema_version: "1.1"
owner: "coordinator:primary"
receiver: "coordinator:recovery"
transfer:
  trigger: "owner_runtime_absent_after_missed_event_and_probe"
reporting:
  event: "phase_acceptance_check_passed_or_blocked"
  deadline: "PT30M"
  one_probe_transition: "recover"
non_gating_utility_review:
  broad_cycle_limit: 2
  on_limit: "compare_direct_route_and_merge_or_defer"
  later_review: "exact_counterexample_only_unless_scope_expands"
```
<!-- goal-authority-reversion:v1:end -->

- One progress authority: this document's "Current State" section, kept
  current at each phase boundary — not an append-only diary.
- Active owners/claims: the shared workspace claim registry governs linked
  worktrees in the broker and `weekly-plans`; check it for current owners before
  resuming or creating a lane. The review-sweep targets (DIGIMON, OntoCanon) use
  their own claim tooling for code changes there.
- Authority transfer/reversion: per the machine block above. Given this
  session crashed and lost work repeatedly earlier tonight (WSL/disk
  instability, documented in `~/projects/.claude/DEVICES_AND_ACCOUNTS.md`),
  the realistic transfer trigger is `owner_runtime_absent_after_missed_event_and_probe`,
  not an explicit handoff. A fresh session recovering this goal should read
  this document's "Current State" section, the referenced plan file, and
  `git log` on both repos before resuming, not just this file's prose.
- Worker reporting/status: single lane, no sub-workers. Report at each phase
  acceptance-check boundary (C1-C7); no polling loop.
- Pinned cross-repository dependencies: **resolved.** The shared client landed
  in `weekly-plans` before the supervisor refactor and review-sweep rebuild;
  C1/C2 pass, and the broker pacer work followed on that stable base.
- Dependency-sensitive stop points: **resolved.** Phase 1's client extraction
  was merged and C1 passed before Phase 3's pacer change began; that dependency
  no longer blocks work.

## Non-Gating Next Actions

- Connecting a third account or a teammate's account remains outside this
  two-account validation. The two-account path has now been demonstrated; any
  colleague trial belongs to deployment/onboarding, not evidence for C3/C4.
- The underlying WSL disk/vhdx issue found earlier tonight
  (`~/projects/.claude/DEVICES_AND_ACCOUNTS.md`) remains open, needs Brian's
  `wsl --shutdown` window, and is explicitly not part of this goal.
- Any future decision to centralize the broker is out of scope per Brian's
  2026-09-25 call and should not be revisited without a new explicit ask.

## Current State

- C1-C5 are complete. The shared client and review-sweep are merged in
  `weekly-plans`; the real sweep run is documented in [PR #163](https://github.com/BrianMills2718/weekly-plans/pull/163)
  and the resulting DIGIMON manifest update is [PR #380](https://github.com/BrianMills2718/digimon_application_20260215/pull/380).
  The 21 supervisor tests, 9 shared-client tests, and 7 review-sweep tests
  pass. At 2026-09-29 16:05Z,
  bridge observations show successful new-conversation asks on two accounts
  three milliseconds apart. Both event-linked archives contain the logged
  55-character first user turn followed by an assistant reply; one snapshot was
  captured later and also contains a subsequent exchange. The persisted pacer
  state has a default entry plus two account-specific entries.
  README documents per-person local deployment. The original plan remains at
  `/home/brian/.claude/plans/async-snuggling-thompson.md`.
- C6 is merged in broker commit
  `34126e375cb08715c88e3ff04c380f0f1068d634`. For unpinned new asks, the broker
  ranks identified accounts with idle agent tabs by projected pacing start,
  accounting for each account's spacing, in-flight asks, and pending
  assignments. Two parallel asks reserve accounts before probing tabs;
  explicit-account asks stay pinned, thread-targeted asks keep their prior
  path, and route decisions link to outcomes with `route_id`.
- **Offline adaptive-routing evidence, 2026-09-30 14:28 UTC.** `npm test`
  passed all 214 tests. `tests/multi-account.test.js` injects a synthetic 429
  on account A, checks that A's pacer widens, and verifies the next automatic
  ask routes to B using earliest projected start, with an `account_route`
  record linked to its successful broker outcome. It also checks parallel
  unpinned asks spread across A and B. The tests use fake tabs and prove the
  mocked route path; they do not show a live account throttle causing a switch
  or establish maximum useful throughput.
- One bounded live unpinned route smoke succeeded earlier (route event
  `156a2f3d-80c7-4405-be1a-4a3fbd25dea3`), but it did not prove a 429-driven
  account switch or an optimal useful rate. Do not describe the scheduler as a
  proven global maximum.
- **Observed traffic readout, 2026-09-30 14:56 UTC (offline snapshot).** The
  report read a temporary copy of the stopped archive: 19,827 `api_request`
  rows across two accounts, comprising 4,039 schema-v2 rows with invalid
  legacy clock alignment and 15,788 schema-v3 rows with valid request starts.
  Schema-v3 starts span 2026-09-29 16:41:59 through 2026-09-30 14:34:49 UTC;
  broker receipt times span 13:32:43 through 14:34:50 UTC. Of these, 15,450
  starts predate the passive observer's 13:31:36 start and arrived in buffered
  observations; 338 started after it began, with no recorded HTTP 429. This is
  connected-page request evidence, not routed prompt volume.
- In the sanitized snapshot, account_1 had 3,500 requests and 6 HTTP 429s
  (0.17%); account_2 had 16,327 requests and 1,133 HTTP 429s (6.94%).
  Account_2 had 1,105 `conversation_list` 429s among 2,071 requests: 1,050 on
  agent tabs (1,050/1,951) and 55 on ordinary tabs (55/120). The 15,788 valid
  schema-v3 rows include 2,558 for account_1 and 13,230 for account_2. These
  observations include ordinary page activity and do not expose hidden quota
  counters. Request rows still omit HTTP method and `route_id`; the 429s cannot
  be attributed to a particular ask, and `conversation` 429s cannot be
  separated into sends versus reads.
- The fresh sanitized report used 681 bridge outcomes and 19,827 request rows;
  a scan found zero raw account/tab/conversation identifiers and no full repo
  path in its output. The bridge archive has 505 successful and 176 failed
  asks. Of these, 428 lack account attribution, but all are older than the
  attributed period: the latest unknown-account ask started at 04:49:26 UTC on
  2026-09-29, and attributed asks begin at 05:01:24 UTC. The existing
  account_1/account_2 success rates remain 15 successes in 3 active UTC
  start-hours (5.0/hour) versus 208 in 14 hours (14.86/hour); the workloads are
  different and are not a controlled capacity comparison. No ask outcome is
  classified as rate-limited. The report contains only 3 broker-action rows,
  all successful and not rate-limited (`navigate_home`, `send_prompt`, and
  `get_reply`), so there is not enough action-level evidence to estimate a
  useful per-account send rate.
- **C7 timing-provenance repair is merged** in PR #68, broker commit
  `8e062c54e64fcdbcb9e4febe9ba4ac7c83cafa4d`.
  New observations keep a page-relative start marker until socket send; the
  broker reconstructs request timestamps from its receipt clocks and elapsed
  age. Best-effort rolling counts use request-start time for observations sent
  within five minutes, with a ten-minute timestamp cache to cover the preceding
  five-minute window; older observations keep raw timing/status but have null
  counts. Legacy client wall-clock events without relative age are dropped.
  Extension version 0.9.16 triggers the existing background-worker
  update/reinject flow; tabs without a working worker remain visibly stale and
  require a manual reload. `npm test` passes 211 tests and `npm run check`
  passes all 16 syntax checks on this revision.
- **Offline telemetry readout is available** through
  `node scripts/bridge-observation-report.js`. It uses schema-v3 request starts
  directly and validates legacy schema-v2 tab offsets before reporting gaps;
  route decisions join ask outcomes by `route_id`. It now splits request
  summaries by account, `agent_tab` state, and endpoint;
  [PR #73](https://github.com/BrianMills2718/chatgpt-conversation-manager/pull/73)
  keeps account, tab, and conversation identifiers report-local and reduces
  source paths to basenames. One automatic route decision joins one-to-one to a
  successful ask outcome, with no account mismatch. This single routed outcome
  is not throughput evidence. The broker service was `inactive` when checked
  at 14:56 UTC; the latest recorded request receipt is 14:34:50 UTC. This
  session used only local archive reads and sent no ChatGPT prompts. The
  338 post-observer page requests are still real account traffic, and their
  zero recorded 429s do not establish a safe send rate. A live throttle-driven
  account switch has not been demonstrated. Useful per-account capacity and
  any optimal or globally maximal rate remain unmeasured.
