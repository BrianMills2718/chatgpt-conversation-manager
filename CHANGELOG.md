# Changelog

## v0.7.0 (2026-09-24)

### Added — the extension keeps itself current; no manual reloads or refreshes

- `extension/background.js`: injects the content script into already-open chatgpt.com tabs on install/update, and every minute compares its version with `extension_version` from the broker's `/health`, reloading itself when they differ. A merged extension change (with a manifest version bump) now reaches every browser without Brian.
- The broker closes a tab's older socket with code 4001 when the same tab token reconnects, so a superseded content script left in the page after an update cannot act on commands a second time. Current code that receives 4001 (a duplicated tab sharing sessionStorage) takes a fresh in-memory token.

## v0.6.0 (2026-09-24)

### Added — any account, any chat, read without sending

Found 2026-09-24: an agent could not see ChatGPT chats Brian had just started, because they were in the ChatGPT desktop app and Edge (no extension), and possibly inside a Project (left out of ChatGPT's main chat list).

- Each tab reports the ChatGPT account it is signed into (`identity` message on connect; `/api/auth/session` identity fields only, never the token). The broker routes by account.
- `read_chatgpt_chat`: read any conversation by id or link — text plus images, saved to `data/images/<thread>/` — without sending into it. Tries every connected account when none is given.
- `list_chatgpt_connections`: connected tabs and their accounts.
- `list_chatgpt_chats` merges chats from inside Projects (`/backend-api/gizmos/snorlax/sidebar`, parsed defensively and failing loudly on an unrecognized shape — unconfirmed against a live account at release) and accepts `account`.
- `ask_chatgpt` accepts `account` and a `chatgpt.com/c/...` link as `thread_id`.
- Images from tool-authored turns (where the image generator puts them) are now included when reading a chat.

## v0.4.0 (2026-09-14)

### Added — scheduled incremental backup

- `archive_all_chats` accepts `known` (thread id -> last capture time) and fetches only conversations new or updated since then (`selectChangedConversations`). A full ~800-chat run takes hours; an incremental one fetches what changed.
- `server/sync.js` `SyncScheduler`: every `SYNC_INTERVAL_MINUTES`, opens ChatGPT if no tab is connected (`SYNC_OPEN_CHATGPT_CMD`), checks the extension supports incremental archive (`get_capabilities`), runs it, and records the outcome in `data/metadata/sync-status.json` (`GET /api/sync-status`). A failed run retries after 30 minutes. `POST /api/sync` runs one now.
- `scripts/run-server.sh` and `scripts/install-windows-startup.sh`: start the broker hidden at Windows logon from WSL (loads nvm; logs to `data/logs/`).

### Fixed — found in the first full live run (2026-09-14)

- 200ms spacing between conversation fetches hit HTTP 429 after ~170 of 795 conversations; 626 of 628 failures were 429. Spacing is now 2.5s, 429 backs off (30s/60s/120s/240s) and then stops the run, 401/403 refreshes the access token once, and 10 consecutive failures stop the run. Unfetched conversations are picked up by the next incremental run.
- Bulk archive is sent to one connected tab instead of every open chatgpt.com tab.

## v0.3.1 (unreleased)

### Added — native ChatGPT Projects mirroring

- **`move_to_project` / `POST /api/move-to-project`**: mirrors an archive-side project assignment into ChatGPT's own native Projects feature (not just our local catalog), via the conversation's own header "..." menu (`[data-testid="conversation-options-button"]`) rather than the sidebar row — this works for *any* thread regardless of whether it's in the sidebar's rendered batch. Handles both moving into an existing project and creating a new one.
- **`navigate_to_thread`**: a same-tab navigation to `/c/<threadId>` is required before a background thread's header menu can be driven (the sidebar only ever renders the ~28 most recent threads and does not paginate on scroll — verified live: neither scrolling, a genuine CDP-trusted wheel event, nor a hard cache-busting reload loaded any more). Since navigation tears down the content-script instance mid-command, this is a two-round-trip server-orchestrated flow (`navigateToThread` in `server/index.js`): send `navigate_to_thread`, poll `get_current_thread_info` on a short per-attempt timeout until the fresh instance reports arrival, then dispatch the real action.
- `currentThreadId()` now also matches `/g/<gizmo-id>/c/<thread-id>` (a conversation that already belongs to a project is served at that path, not plain `/c/<id>`) — the old regex silently failed to recognize arrival for any thread already in a project.
- `scripts/mirror-projects.js`: idempotent batch backfill — reads the catalog, mirrors every thread with an archive-side `project_name` but no `native_project_ref` yet, records the ref on success, safe to re-run.

### Fixed — found live while mirroring ~150 real conversations into projects

- **Rate limiting from automation volume, not a UI-selector bug.** Running `move_to_project` across ~150 threads (each: a full page navigation + several same-origin `backend-api` fetches + DOM menu clicks) triggers ChatGPT's own backend-api rate limiting (`HTTP 429`) after roughly 20–30 rapid operations. Once rate-limited, ChatGPT's own client-side menus (`Move to project`, `New project`) intermittently fail to render/populate — this looks exactly like a DOM-selector/UI-drift bug ("Could not find 'Move to project' menu item") but is downstream of the 429s, not a real UI change. **The rate limit did not clear within ~40 minutes of pausing all activity** (tested twice, same result both times) — budget hours, not minutes, before retrying a full batch. See `project-meta/learnings.md` for the cross-project record of this.
- **Data-corruption side effect of the above, now fixed.** This tool's passive auto-archive (fires 3s after any page load, `scheduleArchive` on WS connect) caught a page mid-navigation during a 429 and silently overwrote a thread's archived title/content with garbage scraped from the wrong page (a project's landing page, not the conversation) — 8 threads' local titles got corrupted this way in one run, 6 also had their local message backup wiped to 0 messages. Nothing on ChatGPT's own servers was ever touched; recovered the 8 titles from each thread's own `*.history.jsonl`. Fixed at the root: `captureSnapshot()` now refuses to save a DOM-scraped capture with zero messages instead of silently overwriting a real prior snapshot.
- A stale-but-not-yet-closed extension WebSocket from the *previous* navigation could briefly overlap with the fresh one from the new page, occasionally causing a command to be answered by (or run against) the wrong page. Fixed: the content script now explicitly closes its own socket right after acking `navigate_to_thread`, instead of waiting for the browser to notice the page is gone.
- Moving a thread into a project client-side-navigates the tab into that project's own scoped view (`/g/g-p-.../project`), whose sidebar only shows that project's conversations — any subsequent sidebar-based lookup for a different thread would silently fail from inside that scope. (Superseded by the header-menu approach above, which doesn't depend on sidebar scope at all, but the underlying navigation behavior is worth knowing.)

### Added — background rename + bulk organization

- **Rename any thread, not just the currently-open one.** `renameViaVisibleUi` now accepts a target thread ID; when it differs from the open tab, the content script finds that thread's sidebar link directly (`conversationLinkById`) and, if not yet rendered, scrolls the sidebar's virtualized list to load it (`scrollSidebarUntilVisible`). `/api/rename` and `/api/number` accept an optional `thread_id` in the request body to use this.
- **Bulk archive via ChatGPT's official data export**, not per-conversation API calls. `scripts/import-chatgpt-export.js` reads `conversations.json` from Settings → Data Controls → Export data (zip, directory, or the file directly) and archives every conversation locally in one pass. Reuses `linearizeMapping`/`buildSnapshot` from the live capture path — same normalization, same content-hash dedup. Avoids the per-conversation-loop approach entirely, which triggered rate-limiting when tried against ~150 real conversations. `capture_source: "export"` distinguishes these from live `"api"`/`"dom"` captures.
- `scripts/apply-organization-plan.js` applies a `{thread_id, project, series?, sequence?, stage?, new_title?}[]` plan against the broker in one pass — project assignment, selective rename, and sequencing.
- Fixed a wiki-generation bug where a thread whose title had already been renamed to include its number/stage (e.g. "01 — Initial Critique — Graph Paper") got that number/stage doubled when listed in the project wiki.

### Fixed — found live while archiving a real ~150-conversation account

- `listAllConversations` pagination relied on the conversations-list endpoint's `total` field to know when to stop; live testing showed `total` is not a real count (behaves like `limit+1`, a cheap "there's more" signal) — a stale run before this fix looped far past the real ~150 conversations, generating heavy duplicate traffic.
- That first fix (stop when a page returns fewer items than requested) was still not sufficient: live testing showed the endpoint can return a full, non-empty page indefinitely past the real end (not literal repeats — genuinely different already-seen ids reshuffled by `order=updated`). Fixed properly: track seen ids across all pages and stop as soon as a page contributes zero *new* ids, regardless of page size. Confirmed live afterward: a clean run reported a believable `total: 101` before hitting an unrelated, separate problem — see below.
- Sustained bulk pagination against this endpoint (~1500+ cumulative requests across the earlier buggy runs) appears to trigger server-side throttling: it started returning intermittent `HTTP 503` with no quick recovery. **Recommendation confirmed by this testing**: prefer `scripts/import-chatgpt-export.js` (ChatGPT's official one-shot export) over the live per-conversation/list-endpoint bulk path for archiving an entire existing history; keep the live API path for what it's actually good at — capturing the one conversation currently open, complete and on demand.

## v0.3.0

### Fixed — found and fixed during live browser verification

Three real bugs surfaced only by testing against a live, authenticated chatgpt.com session (not caught by unit tests, since they're all runtime/browser-integration issues):

- **Content script never actually ran.** `manifest.json` declared `"type": "module"` on the `content_scripts` entry — but Chrome only honors `type: module` for background service workers, not content scripts. The extension loaded with no errors shown at install time, but every page load threw `Uncaught SyntaxError: Cannot use import statement outside a module` and the content script silently never executed at all (no capture, no title fix, nothing). Fixed by wrapping `content.js` in an async IIFE and switching the three `extension/lib/*.js` imports to dynamic `import(chrome.runtime.getURL(...))`, with those files declared in a new `web_accessible_resources` manifest entry.
- **Reconnect storm.** `chrome.storage.onChanged` was firing (and reconnecting the broker WebSocket) on *any* storage change — including `storage.local`, which `persistStatus()` writes after every capture. That created a feedback loop: capture → status write → reconnect → re-capture → ... Observed live: 250+ simultaneous connections to the broker, and Chrome eventually throttling new WebSocket attempts with `Insufficient resources`. Fixed by filtering the listener to `areaName === "sync"` only (settings changes from the options page), which is the only case that should trigger a reconnect. Confirmed stable at exactly 1 connection per open tab afterward, holding with no growth over time.
- **Same-origin API capture 404'd even for a valid, open, logged-in conversation.** Cookies alone turned out not to be sufficient — ChatGPT's own frontend also attaches an `Authorization: Bearer <jwt>` header, obtained from a same-origin `/api/auth/session` call. Confirmed by capturing the real outgoing request headers from a live authenticated session and diffing against what the content script was sending. Fixed by fetching that token fresh per capture (same-origin, never persisted or forwarded) and attaching it; the endpoint now returns 200 and the full conversation tree.

### Fixed

- **Title extraction ("Skip to content" bug).** Root cause: `currentConversationLink()` resolved every sidebar `<a href>` against the current page URL and matched on resolved pathname. An accessibility "Skip to content" link (`href="#main"`) resolves to the *same pathname* as the current page (only the hash differs), so it was indistinguishable from the real conversation link. Fixed by rejecting any hash-only href before path comparison, requiring the resolved path to equal `/c/<thread-id>` exactly, and preferring `aria-current="page"` when present. Title selection is now a pure, unit-tested function (`extension/lib/title.js`) with an explicit priority order and denylist, not a single hard-coded string exclusion.

### Added — reliable long-conversation capture

- **Same-origin API capture path** (`extension/lib/api-capture.js`): the content script now calls `fetch('/backend-api/conversation/<id>', { credentials: 'same-origin' })` — the same in-page request ChatGPT's own web app makes to hydrate a conversation — and linearizes the full message tree by walking the `current_node` parent chain. This is authoritative and complete: it is not affected by DOM virtualization, since it reads the conversation ChatGPT itself maintains server-side rather than whatever is currently mounted in the viewport. No cookies or credentials are exported anywhere; the request runs in-page and its response goes straight into the snapshot.
- **DOM fallback path** remains for when the API call fails (schema change, blocked, transient error). It now scrolls the conversation container to the top a few times first (best-effort mitigation for virtualization) and every DOM-sourced snapshot is tagged `capture_source: "dom"` with an explicit `completeness_warning` string, surfaced all the way to the popup. Snapshots successfully captured via the API path are tagged `capture_source: "api"` with `completeness_warning: null`.
- This directly answers the task's central open question: DOM-only capture cannot guarantee completeness of a long/virtualized conversation, but the same-origin API path can and does, and is now the default.

### Added — extension popup

- Real toolbar popup (`extension/popup.html`/`popup.js`) showing broker connection status, whether a conversation is detected, thread ID, title, last archive timestamp, last archive status/error, current project, sequence, and any completeness warning.
- Buttons: **Capture Now**, **Rename**, **Assign Project**, **Number/Sequence** — each calls the backend's REST API directly (reusing the existing broker-dispatch infrastructure) and surfaces the exact success/error text returned, never silently succeeding.

### Added — observability

- Structured status tracking in the content script (`connected`, `threadId`, `title`, `lastArchiveAt`, `lastArchiveStatus`/`lastArchiveError`, `captureSource`, `completenessWarning`), persisted to `chrome.storage.local` so it survives content-script reloads.
- Broker WS `snapshot_ack`/`snapshot_error` messages now update that status instead of being ignored.
- New optional **debug mode** (options page checkbox) gates console logging — normal users see none.
- Graceful handling of `Extension context invalidated` (the standard "unpacked extension was reloaded while an old tab is still attached" condition): detected once, timers/observer stopped, a single `console.info` explains it, and it is never surfaced to the popup as an archive failure.
- Rename automation now returns explicit, distinct errors for each UI element it fails to find (menu button, rename menu item, rename input) instead of one generic failure, and **verifies** the resulting visible title before reporting success — a rename that "ran" but didn't stick is now reported as a failure with the mismatched title shown.
- Server now logs WS connect/disconnect, rejected (bad-token) connection attempts, and snapshot errors to stdout.

### Added — lineage, status, and undo

- Thread catalog entries now carry `parent_thread_id` and `status` (`current | superseded | reference | final | abandoned`, default `current`).
- New MCP tools/REST endpoints: `set_thread_parent` / `POST /api/lineage`, `set_thread_status` / `POST /api/status`, `undo_last_organization_change` / `POST /api/undo`, `get_project_state` / (MCP only).
- `undoLastAction` reverts the most recent project assignment, sequence/series/stage change, or status change per thread, using before/after state recorded on each action (not full-object diffing, so unrelated later changes aren't clobbered).
- `numberThread` now rejects an **explicit** sequence number already used by another thread in the same project/series instead of silently overwriting it.
- Every thread's archive-side project/sequence/status change was already logged to `catalog.actions`; entries now carry enough `before` state to support the undo above.
- Visible-UI rename undo is intentionally *not* implemented as a one-click ChatGPT UI action (fragile automation on top of automation); the append-only `*.history.jsonl` already preserves every prior title for manual or future automated restoration.

### Added — search filters

- `search_archived_chats` / `GET /api/search` gained `thread_id`, `status`, `since`, `until` filters alongside the existing `project`/`limit`.

### Changed

- `server/index.js` now exports `{ app, server, archive }` and only auto-`listen()`s when run directly (`npm start`), so it can be imported for integration tests without side effects.
- `manifest.json`: content script is now loaded as an ES module (`"type": "module"`) so `content.js` can statically import the new `extension/lib/*.js` modules; added `action.default_popup`.
- Extension version and package version bumped to `0.3.0`.

### Tests

- `node --test` (Node's built-in runner, no new dependencies): 40 tests covering title selection (including the exact "Skip to content" regression), message dedup/snapshot normalization, same-origin API-tree linearization (branch selection, cycle guard, system-message filtering), archive store behavior (content-hash history dedup, sequence allocation/collision rejection, undo, lineage/status validation, search filters, checkpoint/wiki generation), and a light server integration suite (auth enforcement, 404/503 error surfacing).
- Browser/UI automation (rename, live capture against a real logged-in chatgpt.com session) is not automated — see `README.md` → Manual smoke test.

### Known limitations (see README for full detail)

- The same-origin `/backend-api/conversation/<id>` endpoint is private and undocumented; it can change without notice. The DOM fallback exists for exactly that case, but is best-effort only.
- Attachment metadata is captured when present in the API response; attachment bytes are not archived.
- Branch topology: only the currently-selected branch is captured (matches what a user viewing the conversation would see); sibling/rejected branches are not archived.
- Live-verified 2026-08-19 against a real chatgpt.com session, including a real 79-message conversation captured completely via `capture_source: "api"` — see README § "Live verification" for full results.
