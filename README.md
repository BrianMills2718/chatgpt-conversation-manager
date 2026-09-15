# ChatGPT Conversation Manager — v0.3

A narrow browser-extension + MCP bridge for managing and preserving ChatGPT conversations without stealing browser session cookies or calling undocumented private APIs from a *server*.

## What v0.3 adds over v0.2

- **Fixed title extraction.** The "Skip to content" bug is fixed at the root cause (see `CHANGELOG.md`), not papered over with a string exclusion. Title selection is a pure, unit-tested function with an explicit priority order.
- **Reliable long-conversation capture.** The content script now reads the full conversation via the same-origin endpoint ChatGPT's own web app uses to hydrate the page, instead of relying solely on whatever is currently mounted in the (virtualized) DOM. DOM scraping remains as a fallback, explicitly flagged as possibly-incomplete when used.
- **A real popup** showing broker/connection/archive status with **Capture Now**, **Rename**, **Assign Project**, **Number/Sequence** actions.
- **Structured observability**: connection/capture/rename failures are visible, not swallowed; an optional debug mode gates console logging; extension-reload ("context invalidated") conditions are handled gracefully and not confused with real failures.
- **Thread lineage & status** (`parent_thread_id`, `status`), and **undo** for archive-side organization changes.
- Richer **search filters** (thread, status, date range) alongside project/limit.

The archive is authoritative. The generated wiki is a revisable knowledge layer. Vector search is intentionally **not required** in this version.

## Architecture

```text
ChatGPT page
   │
   │ content script:
   │   1. same-origin fetch('/backend-api/conversation/<id>')  ← primary, complete
   │   2. DOM scrape (scroll-to-top best effort)                ← fallback, flagged
   ▼
Chrome extension  ──popup (REST)──┐
   │ WebSocket                    │
   ▼                              ▼
Broker / MCP / REST server ───────┘
   │
   ├── data/raw/chats/<thread>.json
   ├── data/raw/chats/<thread>.md
   ├── data/raw/chats/<thread>.history.jsonl
   ├── data/metadata/catalog.json
   └── data/wiki/<project>.md
             │
             └── lexical/project-aware retrieval
```

The browser extension is deliberately the only component that touches ChatGPT's visible UI or session. **The broker never receives ChatGPT cookies or credentials** — the same-origin API call happens entirely inside the content script (same origin as the page, same browser context) and only its already-public-to-the-page JSON response is forwarded to the broker.

### Why a same-origin API call, and why it's not the thing the task's security rules forbid

ChatGPT virtualizes long conversations: turns that scroll off-screen can be unmounted from the DOM and are not reliably recoverable by scrolling alone. That means DOM-only scraping cannot guarantee complete capture of a long thread — which is the single most important reliability requirement of this project.

`extension/lib/api-capture.js` calls:

```js
fetch(`/backend-api/conversation/${threadId}`, { credentials: 'same-origin' })
```

This is the exact request the chatgpt.com web app itself issues, from the same page, using the browser's existing session — it is not cookie exfiltration (no cookie ever leaves the browser or reaches our broker) and it is not server-side reverse-engineering of a private API (the request originates in-page, in the user's own browser, under the user's own already-authenticated session — the broker never sees it happen and never receives credentials). If this endpoint becomes unavailable or its shape changes, `captureViaApi()` throws and the content script transparently falls back to DOM scraping, tagging the resulting snapshot as `capture_source: "dom"` with a `completeness_warning`.

**Live-verified detail:** cookies alone are not sufficient. ChatGPT's own frontend also attaches an `Authorization: Bearer <jwt>` header, and the endpoint 404s without it. That token is fetched fresh per capture from `/api/auth/session` — the same same-origin session endpoint the page itself calls — and is never persisted or forwarded anywhere; it lives only for the duration of the one capture request. See `getAccessToken()` in `extension/lib/api-capture.js`.

## Current MCP tools

- `capture_current_chat()` — force an archive snapshot now.
- `get_current_chat_title()` — read the current title.
- `rename_current_chat(title)` — rename via ChatGPT's visible UI (verifies the result; fails loudly if the UI can't be found or the title doesn't stick).
- `assign_current_chat_project(project)` — assign durable local project metadata.
- `number_current_chat(project?, series?, stage?, sequence?, rename_visible_chat?)` — assign the next sequence and optionally rename the visible ChatGPT thread, e.g. `03 — Methods Review — Paper title`.
- `set_thread_parent(parent_thread_id)` — record a lineage link (metadata only, no automatic inference).
- `set_thread_status(status)` — `current | superseded | reference | final | abandoned`.
- `undo_last_organization_change(thread_id?)` — revert the most recent project/sequence/status change for a thread.
- `search_archived_chats(query, project?, limit?, thread_id?, status?, since?, until?)` — source-oriented retrieval from archived chats.
- `save_current_chat_checkpoint(summary, status, decisions, open_questions, next_steps, source_message_ids)` — write a high-quality project-memory checkpoint.
- `get_project_state(project)` — thread index + status for a project.
- `list_chatgpt_chats(query?, limit?)` — Brian's most recent chats live from ChatGPT (id, title, last updated), optionally filtered by title. One request, no paging; for older chats or message text use `search_archived_chats`.
- `ask_chatgpt(text, thread_id?, thread_title?, timeout_seconds?)` — type a message into ChatGPT and return the reply. Without `thread_id` or `thread_title` it starts a new chat; with an id, or a title matching exactly one of the 100 most recent chats, it continues that chat (an ambiguous title is refused with the candidates). It only types into the agent tab — a tab opened at `https://chatgpt.com/?ccm_agent=1`, marked with an orange "Agent tab" badge — and never into a tab you are using. If no idle agent tab is open, the broker opens one with `AGENT_TAB_OPEN_CMD` (default: `SYNC_OPEN_CHATGPT_CMD` pointed at that URL). Returns `{ thread_id, url, reply }`, so a follow-up can pass the same `thread_id`.

### Important distinction: archive projects vs ChatGPT Projects

`assign_current_chat_project` currently assigns the thread to **our durable archive project**, independent of ChatGPT's Projects UI. This is intentional: archive integrity should not depend on ChatGPT DOM automation. A later adapter can mirror those assignments into ChatGPT Projects after the relevant UI is tested.

## Archive semantics

Each conversation is saved in three forms:

1. **Current JSON** — structured latest snapshot (includes `capture_source` and `completeness_warning`).
2. **Current Markdown** — portable, human-readable export.
3. **History JSONL** — every materially changed captured snapshot.

Snapshots are content-hashed server-side. A page mutation that does not change title/messages/capture-source does not create another history version.

The metadata catalog stores organization independently:

```json
{
  "thread_id": "...",
  "project_id": "institutional-adaptation",
  "project_name": "Institutional Adaptation",
  "series": "paper",
  "sequence": 4,
  "stage": "Methods Review",
  "status": "current",
  "parent_thread_id": null,
  "capture_source": "api",
  "completeness_warning": null,
  "checkpoints": []
}
```

This separation means renaming or reorganizing a thread does not destroy the raw conversation archive.

## Automatic backup

The broker can back up on a schedule. Every `SYNC_INTERVAL_MINUTES` it asks a
connected chatgpt.com tab to list all conversations and fetch only those new or
updated since their last capture (a full re-download of ~800 chats takes hours;
an incremental run fetches the handful that changed). If no tab is connected it
runs `SYNC_OPEN_CHATGPT_CMD` first and waits up to 90s for one.

- Status of the last run: `GET /api/sync-status` (also written to
  `data/metadata/sync-status.json`): `last_success_at`, `last_result`,
  `last_error`, `failed_threads`.
- Run one now: `POST /api/sync`. Incremental manual run: `POST /api/archive-all`
  with body `{"mode":"incremental"}`.
- Start at Windows logon (WSL): `scripts/install-windows-startup.sh` writes a
  hidden launcher to the Startup folder that runs `scripts/run-server.sh`
  (skips if the broker is already up; logs to `data/logs/server.log`).

Speed is set by ChatGPT, not this tool. Measured 2026-09-14: after a burst,
the conversation endpoint allowed roughly one fetch per 40-60 seconds, so a
600-chat backlog takes on the order of 8-10 hours. The extension paces itself
adaptively (shorter gap after each success, doubled gap on HTTP 429, learned gap
reused next run; see `spacing_ms` / `rate_limited` in progress and
`last_result.pacing`). For a large backlog, the official export plus
`scripts/import-chatgpt-export.js` may be faster.

Requirements that automation cannot remove: Chrome must be running and signed
in to ChatGPT with this extension enabled, and the computer must be awake.
Not yet checked: whether conversations you archived inside ChatGPT appear in
the list endpoint this uses; if they do not, they are not backed up.

## Install

Requirements: Node.js 20+, Chrome/Chromium.

```bash
cd chatgpt-conversation-manager-v0.2
npm install
export RENAMER_TOKEN="$(openssl rand -hex 24)"
npm start
```

Optional:

```bash
export ARCHIVE_DIR="$HOME/ChatGPT-Archive"
```

Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the `extension/` directory.

Open the extension's options page and enter:

```text
Broker URL:    ws://localhost:8787/extension
Token:         same value as RENAMER_TOKEN
Auto archive:  enabled
Debug logging: off (turn on only while diagnosing an issue)
```

Then open a normal ChatGPT conversation. Within a few seconds the archive should contain:

```text
data/raw/chats/<conversation-id>.json
data/raw/chats/<conversation-id>.md
data/raw/chats/<conversation-id>.history.jsonl
```

Click the toolbar icon to open the popup and confirm broker/connection/archive status.

## Automated tests

```bash
npm run check   # syntax check every JS file
npm test        # node --test — 40 unit + light integration tests, no browser required
```

Covers: title selection (including the exact "Skip to content" regression), snapshot normalization/dedup, same-origin API-tree linearization (branch selection, cycles, system-message filtering), archive store (content-hash history dedup, sequence allocation/collision, undo, lineage/status, search filters, wiki generation), and server auth/error-surfacing.

## Manual browser smoke test (required — cannot be automated safely)

Automated testing cannot exercise a real, logged-in chatgpt.com session (that would require either simulating login, which is out of scope/unsafe, or an already-authenticated real browser). Run this manually after loading the extension:

### 1. Basic capture

1. Open a **new** ChatGPT conversation, send one message, wait for the reply.
2. Open the popup: confirm **Broker: connected**, **Conversation: detected**, correct **Thread ID**, and a **Title** that is the real conversation title — *not* "Skip to content", "ChatGPT", or "New chat".
3. Confirm `data/raw/chats/<id>.json` exists and `capture_source` is `"api"` (check the JSON file, or the popup's warning banner is empty).

### 2. Title correctness (the specific bug this release fixes)

1. Open several different existing conversations from the sidebar (not new ones).
2. For each, confirm the popup's **Title** field matches the real sidebar title, especially right after page load (before you've interacted with the page) — this is when the old code was most likely to mis-detect the "Skip to content" link.

### 3. **Critical gate — complete long-conversation archival**

This is the most important test in this project.

1. Open (or create) a **long** ChatGPT conversation — at least 30–50 turns, long enough that ChatGPT would need to virtualize/unmount early turns from the DOM. Scroll to the very top first to see whether early turns are even rendered before you scroll back down and let the extension capture.
2. Trigger a capture (Capture Now in the popup, or wait for auto-archive).
3. Open `data/raw/chats/<id>.json` and verify:
   - `capture_source` is `"api"` (if it's `"dom"`, the fallback engaged — check `completeness_warning` and treat the result as unverified for completeness).
   - The **first** message in the conversation is present.
   - Several **intermediate** messages are present.
   - The **most recent** message is present.
   - Both **user** and **assistant** turns are present throughout, in correct chronological order.
   - No duplicated messages.
4. Report the result honestly even if `capture_source` was `"dom"` for part of the test — that is the exact failure mode this architecture is designed to avoid, and if it happens it means the same-origin endpoint was unreachable/changed and needs investigation.

### 4. Rename

1. Use the popup's **Rename** action on an open conversation.
2. Confirm the visible ChatGPT sidebar title actually changes.
3. Confirm the popup reports success only when the title actually changed (try renaming to an unusual value the automation might fail to detect, and confirm a failure is reported rather than a false success).

### 5. Project / sequence

1. **Assign Project** with a new project name; confirm `data/metadata/catalog.json` gets the project and `data/wiki/<project>.md` is created.
2. **Number/Sequence** the same thread; confirm sequence `01` is allocated, and (if "Also rename visible chat" is checked) the visible title updates to `01 — ...`.
3. Number a second thread in the same project/series; confirm it gets `02`, not `01` again.

### 6. Extension reload handling

1. With a ChatGPT tab open and connected, reload the unpacked extension from `chrome://extensions`.
2. Confirm the old tab's console shows the one-time `"Extension was reloaded; refresh this ChatGPT tab to reconnect."` info message (with debug mode on) — not a spam of stack traces, and not a status that looks like a real archive failure.
3. Refresh the tab; confirm it reconnects normally.

## Direct REST smoke tests

```bash
curl http://localhost:8787/health

curl -X POST http://localhost:8787/api/capture -H "Authorization: Bearer $RENAMER_TOKEN"

curl -X POST http://localhost:8787/api/rename -H "Authorization: Bearer $RENAMER_TOKEN" \
  -H "Content-Type: application/json" -d '{"title":"03 — Methods Review — Institutional Adaptation"}'

curl -X POST http://localhost:8787/api/project -H "Authorization: Bearer $RENAMER_TOKEN" \
  -H "Content-Type: application/json" -d '{"project":"Institutional Adaptation"}'

curl -X POST http://localhost:8787/api/number -H "Authorization: Bearer $RENAMER_TOKEN" \
  -H "Content-Type: application/json" -d '{"series":"paper"}'

curl -X POST http://localhost:8787/api/undo -H "Authorization: Bearer $RENAMER_TOKEN"

curl -G http://localhost:8787/api/search -H "Authorization: Bearer $RENAMER_TOKEN" \
  --data-urlencode 'q=measurement validity'

curl http://localhost:8787/api/current -H "Authorization: Bearer $RENAMER_TOKEN"
curl http://localhost:8787/api/thread/<thread-id> -H "Authorization: Bearer $RENAMER_TOKEN"
```

## MCP connection

```text
http://localhost:8787/mcp
```

For ChatGPT to call it, expose the server through the MCP connectivity mechanism supported by your ChatGPT workspace (for example, a secure HTTPS/tunnel setup). Use bearer auth with the same token. Do **not** expose an unauthenticated broker to the public internet.

### Agents on this machine (Claude Code and Codex)

Both clients are registered as the MCP server `chatgpt-bridge`, so an agent can call `ask_chatgpt` directly:

- Claude Code: `claude mcp add --scope user --transport http chatgpt-bridge http://localhost:8787/mcp -H "Authorization: Bearer <token>"`.
- Codex: `[mcp_servers.chatgpt-bridge]` in `~/.codex/config.toml` with `url = "http://localhost:8787/mcp"` and `bearer_token_env_var = "CHATGPT_BRIDGE_TOKEN"`. `~/.bashrc` exports that variable from `~/.local/state/chatgpt-bridge/token` (mode 600), which holds the same value as `RENAMER_TOKEN`. If you rotate the token, update both.

It needs the broker running and at least one ChatGPT tab open with the extension connected. The other direction — ChatGPT reaching this machine — goes through the separate `remote-mcp` project, not this broker.

## Security model

The prototype intentionally avoids:

- sending ChatGPT session cookies to the broker;
- reverse-engineering private conversation mutation APIs **server-side**;
- arbitrary browser script execution;
- arbitrary shell execution from MCP;
- broad filesystem access through MCP.

The **content script** does call ChatGPT's own same-origin conversation-read endpoint, in-page, using the browser's existing session — see "Why a same-origin API call" above for why this is a deliberate, bounded exception rather than a violation of the above. It is read-only, in-browser, and never forwards credentials.

The broker may write only its configured archive directory. Browser actions are allow-listed in the content script. Treat `RENAMER_TOKEN` as a secret.

## Live verification (2026-08-19)

The critical completeness gate has been run against real, logged-in chatgpt.com conversations (not synthetic fixtures):

- **Title extraction**: verified correct across multiple real conversations opened cold (title present immediately on load, no "Skip to content"/"ChatGPT"/"New chat" misfires).
- **Same-origin API capture**: initially 404'd even for a valid, open, logged-in conversation — cookies alone were not enough. Root-caused live (see "Live-verified detail" above: a bearer JWT from `/api/auth/session` is also required) and fixed; confirmed working end to end afterward.
- **Long-conversation completeness (the critical gate)**: captured a real 79-message conversation via `capture_source: "api"` with `completeness_warning: null`. Verified: first message matches the actual conversation start, last message matches the actual current end, all 79 `message_id`s unique (no duplication), user/assistant/tool roles all present and correctly interleaved in tree order (not naive strict alternation, which this conversation's real structure doesn't follow), all messages carry `created_at`. Three tool→assistant message pairs had timestamps out of order by 1–9 milliseconds — investigated and confirmed benign (a ChatGPT-side metadata quirk on near-simultaneous tool-call/response pairs); ordering itself is by conversation-tree structure, not by `created_at`, so this doesn't affect correctness.
- **Reconnect-storm bug**: found live (`chrome.storage.onChanged` was reacting to `storage.local` writes as well as `storage.sync`, creating a capture→status-write→reconnect feedback loop — observed 250+ simultaneous broker connections). Root-caused and fixed; confirmed stable at exactly 1 connection per open tab, holding steady over time with no growth.
- **Rename**: verified end-to-end against a real conversation — visible ChatGPT sidebar title changed, extension-side verification confirmed the new title, then reverted back to the original title.
- **Popup**: verified renders and reflects live broker/connection state.

Not yet live-verified: Assign Project / Number-Sequence buttons end-to-end against a real conversation (covered by automated tests and manual REST smoke tests, but not re-run live during this pass), and the extension-reload graceful-degradation UX (§6 of the manual smoke test below).

## Known limitations

1. **The same-origin conversation endpoint (and its `/api/auth/session` bearer-token dependency) is private and undocumented.** It can change without notice; the DOM fallback exists for exactly that case but is best-effort only (scroll-to-top mitigation, not a completeness guarantee).
2. **Attachments are not archived as bytes.** Metadata is captured when present in the API response (content type, name, asset pointer).
3. **Only the currently-selected branch is captured**, matching what the user would see; sibling/rejected edit branches are not archived. Full branch-topology capture is a possible future enhancement, not attempted here.
4. **ChatGPT Projects mirroring is not implemented.** Archive-side projects already work and are intentionally independent.
5. **No vector DB.** Deliberate, not missing infrastructure.
6. **No automated wiki synthesis.** Checkpoints are tool-driven.
7. **Visible-UI rename undo is not automated.** Prior titles are preserved in `*.history.jsonl` for manual/future restoration; archive-side metadata changes (project/sequence/status) do have `undo_last_organization_change`.
8. **Multi-tab ambiguity.** The broker dispatches "current thread" commands to all of your connected ChatGPT tabs (never the agent tab, unless it is the only one) and uses the first response; with more than one of your own tabs open, "current" may not mean the tab you're looking at.

## Recommended next increments

- Live-run Assign Project / Number-Sequence and the extension-reload UX check against a real conversation (the two items not covered in the verification pass above).
- If the same-origin endpoint proves unreliable in practice, consider periodic background re-verification (compare DOM message count to API message count when both are available) as a cheap completeness cross-check.
- Attachment byte archival, if a concrete need shows up.
- ChatGPT Projects UI mirroring adapter.
- LLM-assisted wiki reconciliation (v0.4 direction from the original spec).
