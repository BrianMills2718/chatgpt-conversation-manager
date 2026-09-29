# Long-Running Goal: Consolidate ChatGPT orchestration + activate multi-account

## Goal

**Mission:** Stop maintaining two competing ChatGPT-dispatch mechanisms (an
ad-hoc raw-`ask_chatgpt` loop vs. the more mature `weekly_chatgpt_supervisor.py`),
extract the latter's proven dispatch robustness into one shared client, prove
real multi-account dispatch works (never actually tried with two distinct live
accounts), fix the broker's rate-limit pacer so accounts are properly
independent, and document the per-person deployment shape that lets Brian
hand this to a colleague. Full plan and rationale:
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
reply. Claiming Phase 3 done from the pacer code change alone without an
actual live two-account concurrent dispatch and inspection of the persisted
pacer state file showing two independent entries.

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
  documenting per-person deployment.
- Out of scope: any centralized/hosted broker (Brian's explicit call,
  2026-09-25); any new "router" that decides ChatGPT-vs-Claude (Decision 0014
  governs that, reused as-is); `weekly_chatgpt_supervisor.py`'s task-profile
  model itself (`autonomous`/`review_gated`/`hands_on`/`human_only` stays
  exactly as-is — only its dispatch internals move to the shared client).
- Writes allowed: `chatgpt-conversation-manager-v0.2/{server,README.md,CLAUDE.md}`,
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
- Active owners/claims: single active lane, this session/its continuations.
  No coordination-claim tooling exists in `chatgpt-conversation-manager-v0.2`
  (Brian's own single-writer personal tool) or `weekly-plans`; the *targets*
  of the review-sweep (DIGIMON, OntoCanon) do have claim tooling and it is
  used for any actual code changes there, unchanged from tonight's pattern.
- Authority transfer/reversion: per the machine block above. Given this
  session crashed and lost work repeatedly earlier tonight (WSL/disk
  instability, documented in `~/projects/.claude/DEVICES_AND_ACCOUNTS.md`),
  the realistic transfer trigger is `owner_runtime_absent_after_missed_event_and_probe`,
  not an explicit handoff. A fresh session recovering this goal should read
  this document's "Current State" section, the referenced plan file, and
  `git log` on both repos before resuming, not just this file's prose.
- Worker reporting/status: single lane, no sub-workers. Report at each phase
  acceptance-check boundary (C1-C5); no polling loop.
- Pinned cross-repository dependencies: Phase 1 must land in
  `chatgpt-conversation-manager-v0.2` before Phase 1's refactor of
  `weekly-plans/scripts/weekly_chatgpt_supervisor.py` or Phase 2's
  review-sweep rebuild can proceed.
- Dependency-sensitive stop points: do not start Phase 3's pacer change until
  Phase 1's client extraction is merged and C1 passes — the pacer fix and
  the client extraction both touch dispatch-adjacent code and should not be
  developed against a moving base.

## Non-Gating Next Actions

- Connecting a *third* account, or any teammate's actual account, is future
  scope once C3/C4 prove the mechanism with two.
- The underlying WSL disk/vhdx issue found earlier tonight
  (`~/projects/.claude/DEVICES_AND_ACCOUNTS.md`) remains open, needs Brian's
  `wsl --shutdown` window, and is explicitly not part of this goal.
- Any future decision to centralize the broker is out of scope per Brian's
  2026-09-25 call and should not be revisited without a new explicit ask.

## Current State

- Demonstrated (2026-09-25, prior to this goal starting): single-account
  sequential ChatGPT dispatch works end-to-end (multiple real code-review bugs
  found and fixed via the existing raw pathway). Multi-account dispatch:
  never attempted with two real distinct live accounts.
- Technical execution status: Increment 1 and Phase 1 (Increment 2) complete.
  `weekly-plans/scripts/chatgpt_dispatch_client.py` extracted (PR #162,
  merged, commit `b196a14`); `weekly_chatgpt_supervisor.py` refactored to
  import it. C1 verified: all 18 pre-existing supervisor tests pass
  unmodified, plus 5 new tests for the extracted client (23/23), CLI
  smoke-tested (`weekly_chatgpt_supervisor.py validate`). The new client
  also gained account-aware `dispatch_one`/`dispatch_many` entry points for
  Phase 3, ahead of need.
- Phase 3's code side is complete and deployed: `server/index.js`'s
  `agentPacer` is now an `accountPacers` Map keyed by normalized account
  (PR #17, merged, commit `8c5bd83`), with `agentPacer` itself kept as the
  `'(default)'` entry for backward compatibility. Found and fixed a real
  gap while wiring this up: `askChatgpt`'s own `send_prompt`/`get_reply`
  calls only passed `{tab}`, not `{tab, account}`, so an explicit account
  request would have silently landed in the default bucket. Verified: full
  mocked suite 125/125 (was 124), including a new test proving two
  accounts' pacers widen independently via the persisted state file. The
  live broker was restarted (old PID 351 confirmed dead via `ps -p`,
  relaunched via `scripts/run-server.sh`, `/health` and
  `list_chatgpt_connections` confirmed it came back up with real tabs
  reconnected) so this fix is live, not just merged.
- Still only one ChatGPT account is connected to the broker
  (`therakorski@gmail.com`, reconfirmed post-restart). Phase 3's C3/C4
  (real two-account dispatch, per-account pacer state *with a genuine
  second account*) cannot be verified live until a second account is
  connected as an agent tab. This is the one remaining blocker on this
  goal that only Brian can resolve — see "Need anything from human" in
  this session's closeout message. Everything else in Phase 3 that doesn't
  require a second live account is done.
- **Phase 2 complete** (C2): `weekly-plans/scripts/review_sweep.py` built
  on `chatgpt_dispatch_client.dispatch_many` (weekly-plans PR #163, merged,
  commit `ad8e478`) -- replaces the raw `ask_chatgpt` + PowerShell
  focus-lock loop used all through 2026-09-25. Verified with 5 new mocked
  tests AND one real live dispatch against DIGIMON's actual pending
  manifest (`Core/Prompt/RaptorPrompt.py`), which correctly recovered a
  real reply through the broker's known false-timeout bug with zero manual
  intervention, was independently verified, and landed as
  `digimon_application_20260215` PR #380 (merged) -- a real manifest row
  went from `pending` to `clean` using the new dispatch path end-to-end.
- **Phase 4 / C5 complete**: added a "Sharing this with a teammate" section
  to this repo's `README.md`, describing exactly what's built (per-person
  local broker, no centralized/hosted broker) and, per the Forbidden
  Substitutes rule above, explicitly stating what's still unverified
  (per-account pacer code exists but has never run with two real
  simultaneously-connected accounts) rather than describing an aspirational
  state.
- Added `weekly-plans/scripts/verify_multi_account_dispatch.py` (PR #164,
  merged): a ready-to-run script that performs C3/C4's exact check (real
  concurrent `dispatch_many` to two named accounts, then inspects the
  persisted pacer state for two independent account-keyed entries) and
  fails loudly rather than accepting a degraded single-account result. Not
  runnable yet -- still only one account connected -- but removes all
  remaining engineering work from the resume: once a second account is
  connected, this is one command, not ad-hoc work.
- Only C3 and C4 remain, both requiring a genuine second connected ChatGPT
  account -- blocked on Brian; see "Need anything from human" in this
  session's closeout message. Every other acceptance check (C1, C2, C5) is
  done and verified.
- **2026-09-29 update (share-readiness owner).**
  - **Root cause of #27 and #28, fixed.** Bridge v0.8.0 to v0.8.2 (PRs #30 to #34, all merged and deployed; details in CHANGELOG):
    - Every misattributed reply in the 2026-09-27/28 audit was a failed send's prompt left in the composer and then sent by the next ask.
    - Most failed sends were very large prompts whose Send click ChatGPT drops.
    - The bridge now retypes every prompt, verifies attribution against the exact prompt, and re-clicks only after checking ChatGPT's server.
    - Every failure reports `sent=yes/no/unknown`.
    - Asks are paced and logged under their tab's account.
  - **Live checks, one account (therakorski), on 0.8.1:**
    - a new chat with formatting;
    - a continuation, logged under the tab's account;
    - a 73k-character prompt in a hidden tab, with one prompt in the chat and the right reply.

    The server-gated re-click path is covered by unit tests only.
  - **Shared client bug found and fixed.** In `weekly-plans`, `chatgpt_dispatch_client.sent_thread_id` had matched only the pre-v0.7.2 wording "The message was sent". SentWithoutReply recovery therefore never fired from 2026-09-26 until weekly-plans PR #178 (merged `204bd73`), which reads the structured `sent`/`thread_id` fields.
  - **C3/C4 still open.** A second account (brianmills2718@gmail.com) was being connected on 2026-09-29, but `list_chatgpt_connections` still showed only therakorski at 05:20Z. Once it appears, run `weekly-plans/scripts/verify_multi_account_dispatch.py`.
- **C3/C4 PASSED (2026-09-29 16:05Z, bridge v0.9.17 / extension 0.9.13).**
  - **Command.** `weekly-plans/scripts/verify_multi_account_dispatch.py --account-a therakorski@gmail.com --account-b brianmills2718@gmail.com`: one concurrent `dispatch_many` call, both asks started 16:05:23.
  - **C3.** Both returned `verified`. The transcripts were read back directly: `6abbe1ce` under therakorski and `6abbe1cf` under brianmills2718, each "latest reply: finished". Reading `6abbe1ce` under brianmills2718 gave HTTP 404, so the two are distinct accounts.
  - **C4.** `data/observations/agent-pacer-state.json` has independent `therakorski@gmail.com` and `brianmills2718@gmail.com` entries.
  - **Prerequisite (v0.9.17).** Agent tabs are opened by the extension inside the account's own Chrome profile, not by `cmd.exe ... chrome`, which always opened the default profile. Also, one account per Chrome profile: ChatGPT's account switcher changes every tab in a profile.
  - All acceptance checks C1-C5 are now met.
