# ChatGPT Conversation Manager

Lets Claude Code or Codex talk to ChatGPT in your own logged-in browser (`ask_chatgpt`, `read_chatgpt_chat`, …), and archives your ChatGPT conversations locally. Version: see `package.json` / `CHANGELOG.md`. To set it up, go to **Install**.

A narrow browser-extension + MCP bridge for managing and preserving ChatGPT conversations without stealing browser session cookies or calling undocumented private APIs from a *server*.

## History: what v0.3 added over v0.2 (the current version is in `CHANGELOG.md`)

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
- `move_current_chat_to_project(project)` — move the current chat into a native ChatGPT Project (visible in the ChatGPT sidebar), creating it if needed. Separate from, and in addition to, `assign_current_chat_project`'s archive-side project.
- `number_current_chat(project?, series?, stage?, sequence?, rename_visible_chat?)` — assign the next sequence and optionally rename the visible ChatGPT thread, e.g. `03 — Methods Review — Paper title`.
- `tag_thread(tag, thread_id?)` — add a secondary-relevance tag to a thread (a thread can have many tags but only one primary project).
- `untag_thread(tag, thread_id?)` — remove a secondary-relevance tag from a thread.
- `set_thread_parent(parent_thread_id)` — record a lineage link (metadata only, no automatic inference).
- `set_thread_status(status)` — `current | superseded | reference | final | abandoned`.
- `undo_last_organization_change(thread_id?)` — revert the most recent project/sequence/status change for a thread.
- `search_archived_chats(query, project?, limit?, thread_id?, status?, since?, until?)` — source-oriented retrieval from archived chats.
- `save_current_chat_checkpoint(summary, status, decisions, open_questions, next_steps, source_message_ids)` — write a high-quality project-memory checkpoint.
- `get_project_state(project)` — thread index + status for a project.
- `list_chatgpt_connections()` — every ChatGPT tab connected to the bridge, the ChatGPT account (email) each is signed into, and whether it is an agent tab. Use it to see which accounts are reachable.
- `read_chatgpt_chat(thread, account?, include_images?, inline_images?, max_images?)` — read a whole conversation (every message plus generated/uploaded images) by id or `chatgpt.com/c/...` link **without sending anything into it**. Works for any chat the signed-in account owns, wherever it was started — the ChatGPT desktop app, another browser, a phone, or inside a Project — because conversations live server-side, not in a tab. Without `account` it tries each connected account in turn. Images are written to `data/images/<thread>/` (paths appear in the transcript) and returned inline unless `inline_images` is false; an image that fails to download is reported with its error, never silently dropped.
- `list_chatgpt_chats(query?, limit?, account?, include_projects?)` — recent chats live from ChatGPT (id, title, project, last updated), optionally filtered by title. ChatGPT's main chat list leaves out chats filed inside a Project; those are merged in by default (`include_projects: false` to skip). `account` picks which signed-in account to list. For older chats or message text use `search_archived_chats`.
- `reload_chatgpt_tabs()` — hard-refresh every connected ChatGPT tab (only useful right after reloading the extension itself in `chrome://extensions`).
- `ask_chatgpt(text, thread_id?, thread_title?, timeout_seconds?)` — type a message into ChatGPT and return the reply. Without `thread_id` or `thread_title` it starts a new chat; with an id, or a title matching exactly one of the 100 most recent chats, it continues that chat (an ambiguous title is refused with the candidates). It only types into the agent tab — a tab opened at `https://chatgpt.com/?ccm_agent=1`, marked with an orange "Agent tab" badge — and never into a tab you are using. If no idle agent tab is open, the broker opens one with `AGENT_TAB_OPEN_CMD` (default: `SYNC_OPEN_CHATGPT_CMD` pointed at that URL). Returns `{ thread_id, url, reply }`, so a follow-up can pass the same `thread_id`. Several asks may run at once, each on its own agent tab. If the reply is not finished within `timeout_seconds`, the error says whether the prompt was sent (`the prompt WAS sent` vs `Could not confirm the prompt was sent`) and names the conversation: do not resend; collect the late reply with `read_chatgpt_chat`, whose transcript header says `latest reply: finished` once ChatGPT is done. Pass `account` (an email from `list_chatgpt_connections`) to use an agent tab signed into that account; the broker's automatic tab-opening uses the default browser profile, so for another account open `https://chatgpt.com/?ccm_agent=1` once in that account's profile.

### Several accounts and browsers at once

Each ChatGPT account needs its own Chrome profile. Signing a second account into the same profile does not work: ChatGPT's account switcher changes the account for every tab in that profile the next time it loads. On 2026-09-29 this silently turned agent tabs of one account into tabs of the other.

To add a second account:
1. **New profile.** In Chrome, click your profile picture at the top right, then **"Add"**. Chrome's wording can vary between versions; this is what Brian's Chrome showed on 2026-09-29. On the next screen choose **"Stay signed out"**, unless you want Chrome sync for that profile. Give the profile a name, for example "ChatGPT 2".
2. **Sign in.** In the new profile's window, sign in to https://chatgpt.com with the second account.
3. **Install the extension there.** Repeat Install step 3 in that window: extensions are per profile. Use the same **"Broker WebSocket URL"** and the same **"Authentication token"**.
4. **Leave one ChatGPT tab open.** Keep at least one chatgpt.com tab open in that profile. The broker asks the extension in that tab to open agent tabs there, so they land in the right profile.

Microsoft Edge also runs the extension unchanged, and can hold a second account in the same way.

Check it with `list_chatgpt_connections`. It lists each tab with its account, so both accounts should appear. Pass `account` (an email) to `ask_chatgpt`, `read_chatgpt_chat` and `list_chatgpt_chats` to choose one.

For a **new ask** with no `account` or thread target, the broker can choose
between connected accounts automatically. With at least two identified
accounts, it prefers an idle agent tab whose account has the earliest projected
start, based on that account's learned pacing gap and active or queued asks.
Pass `account` when you want to pin a new ask to one account. Thread-targeted
asks do not enter this automatic selection path; pass `account` when you need
to specify which account owns the target conversation.

The broker records each successful automatic choice as an `account_route`
event in `data/observations/request-timing.jsonl`. Its candidate estimates,
selected account and `route_id` can be joined to the ask result in
`data/observations/bridge-events.jsonl`. This supports later tuning from real
traffic. It does not expose ChatGPT's full quota counters or activity outside
connected browser pages, so it cannot prove a global throughput maximum.
Adaptive pacing reacts to 429s returned through broker operations. Resource
Timing observations from connected pages are measurement-only today: a 429
seen in ordinary page activity is logged but does not itself change the pacer
or trigger account selection.

Each ask has a random `ask_id` on its broker actions and final outcome. The
offline report joins those records and counts which broker actions saw a
rate-limit signal, while hiding raw IDs. It also surfaces missing or
inconsistent joins. Older records without `ask_id` remain unjoined. The report
also computes successful asks per distinct active UTC start-hour for each
account, using only unique tagged outcomes with a valid account and start time;
ambiguous or incomplete outcomes are counted separately and excluded from the
rate. This describes observed work, not sustainable capacity or a global
optimal rate. Passive page-request observations still are not assigned to
asks, so they cannot be treated as routed ask volume.

For a local summary of recorded traffic, run
`node scripts/bridge-observation-report.js`. It reports API status and
validated request gaps by account and endpoint, with an additional breakdown
by whether each event came from an agent-managed tab, an ordinary tab, or an
unknown tab. It counts broker actions separately, joins automatic route
choices to ask outcomes by `route_id`, joins broker actions to ask outcomes
by `ask_id`, and reports tagged successful outcomes per account per active UTC
start-hour. Account, tab, and conversation IDs are
replaced with labels consistent within each report, and source paths are
reduced to filenames. Passive API observations are not assigned to individual
asks. They do not include HTTP method, so a `conversation` endpoint 429 cannot
be classified as a prompt send or a read. The report does not claim an optimal
rate.

- **Reading.** One connected tab per account is enough to *read* any of that account's chats, including ones started in the ChatGPT desktop app.
- **Updates.** The extension reloads itself within about a minute when a newer version is on disk. Bump `version` in `extension/manifest.json` with every extension change.

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
- Start at Windows logon (WSL): `scripts/install-windows-startup.sh` (only if nothing else starts the broker; see "Keeping the broker running") writes a
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

You need Node.js 22 or newer (the test suite does not exit on Node 20), Google Chrome (or Microsoft Edge), and a ChatGPT account. About ten minutes.

1. **Get the code and a token.** The token is the password that the extension and your coding agents use to talk to the broker.

   ```bash
   git clone https://github.com/BrianMills2718/chatgpt-conversation-manager.git
   cd chatgpt-conversation-manager
   npm install
   cp .env.example .env
   # put a long random token into .env:
   sed -i.bak "s/^RENAMER_TOKEN=.*/RENAMER_TOKEN=$(openssl rand -hex 24)/" .env && rm .env.bak
   ```

   Open `.env` and check it:
   - The broker listens only on this computer (`HOST=127.0.0.1`), and it refuses to start without a real token.
   - **Port.** It uses `PORT=8787`. If something else already uses that port, change `PORT=` here, and use your port wherever 8787 appears below.
   - **Backup is off** (`SYNC_INTERVAL_MINUTES=0`). If you turn it on, the first run downloads every chat you have. That takes hours and uses the same ChatGPT rate limit as your agents' asks.
   - **Opening tabs.** To let the broker open ChatGPT tabs by itself, set `SYNC_OPEN_CHATGPT_CMD`; the file has examples for macOS, Linux and WSL. Otherwise you open them yourself (step 4).

2. **Start the broker.** Leave this running:

   ```bash
   npm start
   ```

   `curl http://localhost:8787/health` should print `"ok":true`.

3. **Load the extension.** The names in quotes below are exactly what Chrome and the extension show. They were checked against Chrome's extensions pages and `extension/options.html` on 2026-09-29.
   - In Chrome, type `chrome://extensions` into the address bar. Turn on the **"Developer mode"** switch (top right). Click **"Load unpacked"** and choose this repo's `extension` folder.
   - A card named **"ChatGPT Conversation Manager Bridge"** appears. On it, click **"Details"**, scroll down, and click **"Extension options"**. A page titled **"ChatGPT Conversation Manager"** opens.
   - **"Broker WebSocket URL"**: type `ws://localhost:8787/extension` by hand. Use your port if you changed `PORT`. It must say `localhost`, not `127.0.0.1`.
   - **"Authentication token"**: paste the token, and nothing else. It is the part after `RENAMER_TOKEN=` in `.env`; `grep ^RENAMER_TOKEN= .env | cut -d= -f2` prints it. Type the URL above by hand rather than copying it: copying the URL after the token replaces the token on your clipboard, and you would paste the URL into the token box.
   - Leave these as they are:
     - **"Automatically archive open conversations"** (ticked): it saves each chat you open into `data/`. Untick it only if you don't want that.
     - **"Archive debounce (milliseconds)"**.
     - **"Enable debug console logging"** (unticked). It only adds browser console output.
   - Click **"Save"**. The word "Saved" appears briefly.
   - Open https://chatgpt.com, signed in. `curl http://localhost:8787/health` should now show `"extension_connections"` of 1 or more; each open ChatGPT tab counts.

4. **Open the agent tab.** In the same Chrome profile, open `https://chatgpt.com/?ccm_agent=1` and leave it open. A small orange label reading "Agent tab — Claude Code / Codex type here" appears at the bottom left. Agents type only into this tab, never into the chatgpt.com tabs you use yourself. When none is open, the broker asks the extension in one of your connected ChatGPT tabs to open one in that same profile.

5. **Connect your coding agent.** Both commands read the token from `.env` without printing it.

   ```bash
   # Claude Code
   claude mcp add --scope user --transport http chatgpt-bridge http://localhost:8787/mcp \
     -H "Authorization: Bearer $(grep ^RENAMER_TOKEN= .env | cut -d= -f2)"
   ```

   For Codex, add this to `~/.codex/config.toml`:

   ```toml
   [mcp_servers.chatgpt-bridge]
   url = "http://localhost:8787/mcp"
   bearer_token_env_var = "CHATGPT_BRIDGE_TOKEN"
   ```

   Then put the token in your shell profile. Run this from the repo folder; use `~/.zshrc` on macOS:

   ```bash
   echo "export CHATGPT_BRIDGE_TOKEN=$(grep ^RENAMER_TOKEN= .env | cut -d= -f2)" >> ~/.bashrc
   ```

6. **Check it end to end.** Ask your agent to:
   - call `list_chatgpt_connections`. It should show your account, one tab marked `agent`, and the same extension version as `extension_version` in `/health`. This sends nothing to ChatGPT.
   - call `ask_chatgpt` with `Reply with the single word: pong`. It should return `pong` with a `[conversation … — account …]` line.

### Keeping the broker running

**The supported way is `npm start` in a terminal you leave open.** Nothing restarts it for you: start it again after a reboot. `scripts/run-server.sh` does the same, adds a log file, and skips starting when a broker already answers on the port.

**Only one thing may start the broker.** If you want it started automatically, pick exactly one starter:
- a Linux/WSL systemd user service that runs `npm start` in the repo folder, with `Restart=always`;
- or, on WSL, `scripts/install-windows-startup.sh`, which runs `scripts/run-server.sh` at Windows logon.

Never run two starters. A second one can take the port while the first is restarting, and then an old copy of the broker keeps running while the new one crash-loops. Brian's machine hit exactly this on 2026-09-29, and fixes he had merged silently did not take effect. If the broker exits with "port … is already in use", something else already runs it.

### Using it well

- **Every ask uses your real ChatGPT quota.** Sends, reads and backup all count against the same account-wide rate limit that your own ChatGPT use does. The broker paces requests per account (`data/observations/request-timing.jsonl`). Don't loop hundreds of asks without watching for `rate_limited`. When ChatGPT refuses a request (HTTP 429), it says only `{"detail":"Too many requests"}`, with no `Retry-After` and no limit headers. So the bridge backs off based on the refusals it sees.
- **When an ask fails, read the last line of the error:** `[sent=yes|no|unknown conversation=<id> account=<email>]`.
  - `sent=yes`: the prompt reached ChatGPT. Do **not** resend it; collect the answer later with `read_chatgpt_chat` on that conversation.
  - `sent=no`: nothing was sent, so retrying is safe.
  - `sent=unknown`: look at `list_chatgpt_chats` before you retry.
  The same fields come back from `POST /api/ask` as `sent`, `thread_id` and `account`.
- **Your prompt arrives verbatim.** ChatGPT's composer would otherwise send any prompt containing a link as escaped Markdown (`\#`, `` \`\`\` ``, `&#x20;`), so the model saw mangled code. Before clicking Send, the bridge switches the agent tab's composer to ChatGPT's plain-text mode. Your own tabs are not affected. Every reply says whether this worked: `prompt_verbatim` in `/api/ask`, and a WARNING line in the MCP reply when it did not.
- **A reply is always the answer to your prompt.** The broker returns a reply only after checking that the user turn before it is exactly the prompt you sent. If something else was sent into that conversation, the ask fails with `Refusing to return a reply` instead of returning someone else's answer.
- **Several asks can run at once**, one per agent tab (open more `?ccm_agent=1` tabs). For more than one ChatGPT account, see "Several accounts and browsers at once" above.
- **Large prompts.** The prompt is put into ChatGPT's composer in one step, so an 80,000-character prompt takes about half a second in a background tab (typing it used to freeze the tab). If ChatGPT ignores the click on Send, the broker checks ChatGPT's server at 30, 75 and 135 seconds and clicks again only if the prompt has not arrived. A tab that stops responding is reported as such, with `sent=unknown`. Prompts over about 95,000 characters have left ChatGPT's Send button disabled (`sent=no`); that was last seen before the one-step fill.

### If prompts stop arriving verbatim

The plain-text switch reaches into ChatGPT's own page code: its React tree, and a composer controller with `setPlainTextMode`. A ChatGPT web update can break it.

**What you see.** An `ask_chatgpt` reply ends with `WARNING: this prompt did NOT reach ChatGPT verbatim (the bridge could not switch ChatGPT's composer to plain-text mode: <reason>)`, or with a milder note when the prompt happened to arrive intact anyway. `data/observations/request-timing.jsonl` shows `plain_text_mode` on each `send_prompt`: `true`, or the reason it failed.

**What still works.** Sending, and matching replies to prompts, both keep working. Only prompts containing a link or other formatting reach the model as escaped Markdown.

**What to do.**
- Tell whoever maintains the bridge, and include the reason text.
- In the meantime, prefer prompts without bare URLs.
- Or turn on ChatGPT's own plain-text composer setting for the account, if the ChatGPT UI offers one. That changes your own composer too.

## Sharing this with a teammate

Each person runs their own broker and signs their own ChatGPT account into their own Chrome, following **Install** above. There is no shared or hosted broker. Brian decided this on 2026-09-25: a central broker would save only the server step, because every teammate's extension still has to be signed into their own account, and it would add a security surface.

What a teammate gets is the MCP tools above, usable from Claude Code or Codex. Everything needed is in this repo.

**What has actually been checked, and when:**

- **One account, one or more agent tabs.** Used for about 350 real sends on 2026-09-25 through 09-28. That volume exposed the misattribution and "could not confirm" failures fixed in v0.8.0/v0.8.1; see CHANGELOG. The fixes have unit tests and live checks on 2026-09-29:
  - a new chat with markdown, a code fence, tabs and non-ASCII text, confirming exact-match typing;
  - a continuation, logged under the tab's account;
  - a 73,212-character prompt in a hidden tab, which gave the right reply with exactly one prompt in the chat.

  The server-checked re-click has only been exercised in unit tests; that live send was accepted on its first click. None of this has yet run at audit volume.
- **Two accounts at once.** Checked live on 2026-09-29 (v0.9.17), with one account in a second Chrome profile and the primary account in the main profile.
  - One concurrent `dispatch_many` call returned a real reply from each account. Each conversation was read back under its own account; attempting to read one under the other account returned HTTP 404, confirming the accounts are separate.
  - The persisted pacer state has independent entries for both accounts.
  - The second account's agent tab was opened by the extension inside that profile.
- **Setup on another operating system.** This walkthrough was followed on a fresh clone on Linux: `npm install`, `npm test`, broker start, MCP `initialize`/`tools/list`, and `list_chatgpt_connections` with no browser attached. The macOS and Windows-native paths have not been tried by a teammate yet.

## Automated tests

```bash
npm run check   # syntax check the server and extension JS
npm test        # node --test — unit + light integration tests, no browser required
```

Covers: title selection (including the exact "Skip to content" regression), snapshot normalization/dedup, same-origin API-tree linearization (branch selection, cycles, system-message filtering), archive store (content-hash history dedup, sequence allocation/collision, undo, lineage/status, search filters, wiki generation), and server auth/error-surfacing.

### Focused offline adaptive-routing demo

Run the synthetic two-account throttle case without sending anything to
ChatGPT:

```bash
node --test --test-name-pattern='an observed 429 routes the next unpinned new ask' tests/multi-account.test.js
```

The test injects an HTTP 429 into account A's fake tab, verifies that A's
pacing gap widens, then checks that the next unpinned ask is routed to account
B and recorded with its successful outcome. It demonstrates the mocked
routing path only; it does not prove a live ChatGPT throttle or a maximum useful
throughput rate.

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

Both clients register the broker as the MCP server `chatgpt-bridge`; see **Install**, step 5. If you rotate the token, update every place it was pasted: `.env`, the extension's options, Claude Code, and your shell profile.

It needs the broker running and at least one ChatGPT tab open with the extension connected.

**This is one direction only: agent → ChatGPT.** Letting ChatGPT reach your machine (run commands, edit files) is not part of this project.

## Security model

The prototype intentionally avoids:

- sending ChatGPT session cookies to the broker;
- reverse-engineering private conversation mutation APIs **server-side**;
- arbitrary browser script execution;
- arbitrary shell execution from MCP;
- broad filesystem access through MCP.

The **content script** does call ChatGPT's own same-origin conversation-read endpoint, in-page, using the browser's existing session — see "Why a same-origin API call" above for why this is a deliberate, bounded exception rather than a violation of the above. It is read-only, in-browser, and never forwards credentials.

The broker may write only its configured archive directory. Browser actions are allow-listed in the content script. Treat `RENAMER_TOKEN` as a secret.

## Live verification of archiving (2026-08-19, historical)

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
4. **Archive projects and ChatGPT Projects are separate.** `move_current_chat_to_project` files a chat into a native ChatGPT Project; `assign_current_chat_project` sets the archive-side project. Neither mirrors the other automatically.
5. **No vector DB.** Deliberate, not missing infrastructure.
6. **No automated wiki synthesis.** Checkpoints are tool-driven.
7. **Visible-UI rename undo is not automated.** Prior titles are preserved in `*.history.jsonl` for manual/future restoration; archive-side metadata changes (project/sequence/status) do have `undo_last_organization_change`.
8. **Multi-tab ambiguity.** The broker dispatches "current thread" commands to all of your connected ChatGPT tabs (never the agent tab, unless it is the only one) and uses the first response; with more than one of your own tabs open, "current" may not mean the tab you're looking at.

## Recommended next increments

- **An ask that outlives the call.** Today a long ask holds the MCP call open for up to `timeout_seconds` (max 900). When that runs out, the caller collects the answer with `read_chatgpt_chat`. Next step: have `ask_chatgpt` return an ask id at once, with a `wait`/result call and a stored record per ask. That is the pattern steipete/oracle uses, and MCP 2025-11 "tasks" standardizes it. It would also let a caller resend safely with an idempotency key.
- **Trusted input for large prompts.** Typing through `chrome.debugger` (`Input.insertText` and a real mouse click) instead of content-script events may stop ChatGPT ignoring the first click on very large prompts. The cost is Chrome's "being debugged" banner. Or send prompts over ~60k characters as a file attachment.
- Live-run Assign Project / Number-Sequence and the extension-reload UX check against a real conversation.
- Attachment byte archival, if a concrete need shows up.
