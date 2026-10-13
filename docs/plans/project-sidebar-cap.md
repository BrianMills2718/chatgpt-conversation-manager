---
schema_version: "1.0"
artifact_type: design_plan
id: project-sidebar-cap
plan_id: project-sidebar-cap
status: proposed
planning_path: requested
method_conformance_receipt: docs/plans/project-sidebar-cap.receipt.json
conflict_surfaces:
  - {kind: repository_path, repository: "BrianMills2718/chatgpt-conversation-manager", target: "server/index.js", access: write}
  - {kind: repository_path, repository: "BrianMills2718/chatgpt-conversation-manager", target: "extension/lib/api-capture.js", access: write}
  - {kind: repository_path, repository: "BrianMills2718/chatgpt-conversation-manager", target: "extension/content.js", access: write}
  - {kind: repository_path, repository: "BrianMills2718/chatgpt-conversation-manager", target: "tests/api-capture.test.js", access: write}
  - {kind: repository_path, repository: "BrianMills2718/chatgpt-conversation-manager", target: "CHANGELOG.md", access: write}
trace_review_criteria:
  - criterion_id: outcome
    expected_outcome: pass
goal:
  outcome: "list_chatgpt_chats with a title query stops failing with HTTP 422, because no caller asks ChatGPT's Projects sidebar for more than 20 chats per project"
  canonical_example: "list_chatgpt_chats(limit=20, query='model') returned 'projects sidebar fetch failed: HTTP 422' before; after the broker restart it returns matching chats."
  forbidden_substitutes: "claiming success from a check's last line or exit status alone; a change outside the listed files; a commit without the saved check output"
  boundaries: "only these files: server/index.js, extension/lib/api-capture.js, extension/content.js, tests/api-capture.test.js, CHANGELOG.md; no irreversible action and no spend; Brian's request as quoted is the scope"
  done_when: "tests/api-capture.test.js new test asserts listProjectChats sends conversations_per_gizmo=20 when asked for 100 and 5 when asked for 5; full npm test passes; one live list_chatgpt_chats call with a query, which runs the whole README Architecture path (MCP tool -> broker -> WebSocket -> extension content script -> ChatGPT Projects sidebar), returns chats instead of HTTP 422. The check's full output on the parent commit and on the change commit is committed as docs/plans/project-sidebar-cap.check.txt, and the commit is tagged [Goal project-sidebar-cap] with an Asked: line quoting the request."
  do_not_gate_on: "Brian's review of the plan page; work outside the listed files"
---

# Cap Projects sidebar request at 20 per project

## When a run fails or surprises us

This procedure is separate from the anticipated failure named in the disproof
under Success and disproof: it applies to any run that fails or surprises us.
Preserve the failed run itself: keep its complete output (command, every
line, exit status) and its execution trace id, never overwritten by a rerun.
Before selecting a fix,
read the complete inputs, prompts, tool arguments/results, intermediate stages
and final output, including the full check command/output and the changed files.
Cite the observed divergence and classify evidence absent, returned but unused
or contradicted, invalid expectation, or unresolved. An unresolved diagnosis
cannot authorize a causal repair; it permits only further investigation. Bind the targeted repair to a new
traced verification run; retain the failed original. Review every failing or
surprising item and a sample of passes. A complete review is distinct from a
passing run. Criterion `outcome` covers the entire requested success check.

## Actor and result

**Actor:** Brian, who asked for this change.

**Request (verbatim):** Brian 2026-10-13 "i approvb but do tha tfor me" (reconnect the ChatGPT bridge so his Oct 4-12 ChatGPT chats can be searched)

**Desired result:** list_chatgpt_chats with a title query stops failing with HTTP 422, because no caller asks ChatGPT's Projects sidebar for more than 20 chats per project.

**Stable example:** list_chatgpt_chats(limit=20, query='model') returned 'projects sidebar fetch failed: HTTP 422' before; after the broker restart it returns matching chats.

## Authority and non-goals

**Authority:** Brian asked for this change in his own repository; one agent makes it.

**Non-goals:** nothing outside the files listed under Vertical and reset. No irreversible action and no spend.

## Requirements

| Id | Requirement | Source | Check | Status |
| --- | --- | --- | --- | --- |
| R1 | list_chatgpt_chats with a title query stops failing with HTTP 422, because no caller asks ChatGPT's Projects sidebar for more than 20 chats per project. | asked: Brian 2026-10-13 "i approvb but do tha tfor me" (reconnect the ChatGPT bridge so his Oct 4-12 ChatGPT chats can be searched) | the success check under Success and disproof, its output saved as `docs/plans/project-sidebar-cap.check.txt` | planned, not yet run |
| R2 | No model is called by this change and nothing grades a model: list_chatgpt_chats reads ChatGPT's own chat list over HTTP, so llm_central is false | stated with the request | git diff shows no LLM client import or call | planned, not yet run |

Requirements the change's own claims imply are listed above as R2 onward.

## Success and disproof

**Success evidence:** tests/api-capture.test.js new test asserts listProjectChats sends conversations_per_gizmo=20 when asked for 100 and 5 when asked for 5; full npm test passes; one live list_chatgpt_chats call with a query, which runs the whole README Architecture path (MCP tool -> broker -> WebSocket -> extension content script -> ChatGPT Projects sidebar), returns chats instead of HTTP 422.

**Trace review:** two runs of the success check above are judged from their full output: one on the parent commit before the change (the disproof run: it must show the defect or the check failing, which proves the check can fail) and one on the commit that makes the change (the success run); no model, agent or LLM pipeline runs under this plan. Where the trace lives: the check's complete output, with the exact command and its exit status, is saved as `docs/plans/project-sidebar-cap.check.txt` and committed with the change. What must be seen in it beyond the final result: the command ran against the files listed under Vertical and reset at that commit, each check or test it reports appears by name with its result and none is skipped, and the exit status matches; for each model element listed under System model, the output shows what that line says. Both runs are saved in that one file, each headed by its commit: the disproof condition is judged from both (it holds if the success run still shows the defect, or if the before run already passes, meaning the check cannot detect it), and success from the success run.

**Disproof:** The new test fails, or the live query call still returns HTTP 422 after the broker restart.

## System model

**System model:** `README.md`, a file in this repository describing this repository only (not a shared model). Reachable from the documentation entry point `README.md`, which links `README.md`.

**Model elements this change adds, changes or relies on, and what the saved check output must show of each:**

- README.md 'Architecture' section (README.md is the repository's documentation entry point, the page GitHub shows first): the path MCP tool -> broker (server/index.js) -> WebSocket -> extension content script -> listProjectChats -> /backend-api/gizmos/snorlax/sidebar, which this change caps at 20 per project. Freshness check: the live list_chatgpt_chats query call runs that whole path end to end and its output must show project chats returned through it; tests/api-capture.test.js checks the request URL on every npm test run and must show conversations_per_gizmo=20 for a request of 100

**Views, freshness and reconciliation:** the applicable view is the requirement-to-verification link in the Requirements table (each requirement and the check that shows it, the check being source-linked by its command); no other view applies because the change adds, changes or relies on no entity, process, record, event or view beyond the elements listed above. Freshness: the model's drift test (`tests/multi-account.test.js`) runs inside the success check and its output is in the saved check file. If an element above is added, removed or renamed, the model, its view coverage and the saved check output are reconciled in the same commit, and otherwise the model needs no update because the elements keep their meaning.

## Capability reuse

Checked against the capability catalogue in agentic-capability-architecture-canonical (`reuse_candidates.yml` and `capability_registry.yml`):

- No catalogue entry fits, because this fixes a request parameter inside the existing chatgpt-bridge tool
- What the work needs that no entry provides: edits to this repository's own files (`server/index.js`, `extension/lib/api-capture.js`, `extension/content.js`, `tests/api-capture.test.js`, `CHANGELOG.md`); catalogue entries are cross-project capabilities, and none edits a repository's own source.

## Uncertainties

Material uncertainties. This one is the complete set; it is material because a file outside the list would
make the change exceed this plan's scope.

| Material uncertainty | Owner or resolving evidence |
| --- | --- |
| Whether the change needs files beyond the list below; if so it is out of scope for this plan | Resolved before editing: git diff --stat: 5 files, 23 insertions, 2 deletions |

## Vertical and reset

One vertical over these files (and the saved check output, `docs/plans/project-sidebar-cap.check.txt`):

- `server/index.js`
- `extension/lib/api-capture.js`
- `extension/content.js`
- `tests/api-capture.test.js`
- `CHANGELOG.md`

The vertical delivers: list_chatgpt_chats with a title query stops failing with HTTP 422, because no caller asks ChatGPT's Projects sidebar for more than 20 chats per project. It is done when this holds: tests/api-capture.test.js new test asserts listProjectChats sends conversations_per_gizmo=20 when asked for 100 and 5 when asked for 5; full npm test passes; one live list_chatgpt_chats call with a query, which runs the whole README Architecture path (MCP tool -> broker -> WebSocket -> extension content script -> ChatGPT Projects sidebar), returns chats instead of HTTP 422.

Make the change, run the success check before and after it, commit. Reset: `git revert` of the commit. Not pursued: anything outside these files. This plan adds no coordinated-work ceremony: no work-unit graph, no review or release contract, no claim beyond the repository's own rules.

## Activation facts

Each fact, with its value and why:

- `shared_mechanism`: false -- the change edits only the listed files and adds no contract, algorithm or mechanism other code uses.
- `empirical_comparison_proposed`: false -- no alternatives are compared; the success check verifies the one change.
- `llm_central`: false -- the change makes no model call.
- `irreversible_or_spend_action`: false -- the change is reverted by `git revert` and spends nothing.
- `claims_external_standard`: false -- the work claims no external standard, schema or contract.
- `aes_governed_target`: false -- this repository has no `.aes/target.yaml` (checked by quick-adopt).
- `durable_documents_declared`: false -- `.agentic/repo.yaml` declares no `durable_documents` (checked by quick-adopt).
