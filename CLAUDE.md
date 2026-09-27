# chatgpt-conversation-manager-v0.2

Read this before touching the repo. It complements `README.md` (setup, MCP tools, architecture)
with what an agent needs to not repeat mistakes made here before.

## Which direction is this repo?

This repo is **agent → ChatGPT**: it lets Claude Code or Codex drive and read Brian's own logged-in
ChatGPT browser tab (`ask_chatgpt`, `list_chatgpt_chats`, capture/organize tools — see README's
"Current MCP tools"). The broker (`server/index.js`) talks to a Chrome extension over a local
WebSocket; nothing here gives ChatGPT itself any access to anything.

**ChatGPT → machine** (ChatGPT running commands, editing files, or handing work to Claude Code/Codex
on Brian's own computers) is a completely separate project, `~/code/remote-mcp`
(`https://rmcp.brianmills.dev`, added as a connector inside ChatGPT's own Developer Mode). It is the
self-hosted replacement for a third-party tool called "Desktop Commander" — if you see that name
anywhere, it refers to what remote-mcp replaced, not anything in this repo. These two repos are
genuinely different systems; confusing them (in either direction) has caused real confusion more than
once — see `remote-mcp/docs/chatgpt-setup.md` for the other direction, and keep both directions
straight in anything you write about this repo.

## Working in this repo

- `.`, `server/`, and `tests/` in the **main checkout** are deliberately `chmod 555` (read-only) — a
  mechanical guardrail against editing main directly. Work in a linked worktree
  (`git worktree add -b <branch> worktrees/<name> main`), test, push, open a PR, merge, then sync main
  by temporarily `chmod u+w`-ing those three paths, `git merge --ff-only origin/main`, and restoring
  `chmod 555` on all three immediately after. Never leave the lock off.
- The live broker's cwd is the main checkout, so a merged fix only takes effect once you restart the
  process there — restarting doesn't need any client action. As of 2026-09-26 the live broker runs
  under the systemd user unit `chatgpt-bridge.service` (`~/.config/systemd/user/`, `Restart=always`):
  restart it with `systemctl --user restart chatgpt-bridge`, not by killing it and relaunching
  `scripts/run-server.sh` (systemd relaunches a killed broker within 5s on its own, so a manual
  relaunch just races it). Its logs go to `journalctl --user -u chatgpt-bridge`, not
  `data/logs/server.log`. A restart drops any in-flight `ask_chatgpt`, so first wait until
  `data/observations/request-timing.jsonl` shows no `get_reply`/`send_prompt` for ~45s (an ask
  waiting on a reply logs an API-checked `get_reply` about every 10s).
- An extension change is meant to reach the browser **without Brian**, as long as you **bump `version` in
  `extension/manifest.json`** in the same change: the broker's `/health` reports the on-disk version,
  and `extension/background.js` checks it every minute, calls `chrome.runtime.reload()` when it
  differs, and on reload injects the new content script into every open chatgpt.com tab (Chrome
  otherwise leaves open tabs on old code until refreshed). The broker closes a tab's older socket
  (code 4001) when the same tab reconnects, so superseded code left in the page cannot act on
  commands twice. Without a version bump nothing reloads. **This auto-reload has failed at least
  once:** 0.7.3 sat on disk for over an hour on 2026-09-27 while the tabs kept running 0.7.2 (its
  fingerprint: reply-check API reads every ~10s through HTTP 429 streaks, which 0.7.3 backs off to
  20s and more). The cause is not known yet; the service worker's console (chrome://extensions,
  "service worker" link) was not inspected. So verify that a change landed: from 0.7.4 on, each tab
  reports its running version, `GET /health` lists `extension_versions_running` next to the on-disk
  `extension_version` (a broker-local check that costs no ChatGPT request), and the broker log warns
  when a tab connects with a version that differs from the one on disk. If the new version isn't
  running, Brian has to reload the extension by hand (chrome://extensions, reload "ChatGPT
  Conversation Manager Bridge"). The first install into a new browser/profile (Load unpacked +
  token) also needs Brian.
- There's also a supervised Windows Task Scheduler launcher for this same broker
  (`remote-mcp/deploy/windows/chatgpt-bridge.ps1`, installed as task "ChatGPT Bridge (\<user\>)",
  restart-on-failure, "At logon" trigger) — an alternative to manually running `scripts/run-server.sh`.
  Check `schtasks /query` (via `cmd.exe`) before assuming a manual restart is the only supervision in
  play, and before assuming the broker is down just because nobody manually started it.

## Live-call discipline (real incident, 2026-09-17)

Every `ask_chatgpt`/`list_chatgpt_chats` call shares Brian's real, rate-limited ChatGPT account quota
with his own concurrent usage — it is not a sandboxed test account. `listRecentChats`'s own code
comment says as much: "it shares the account's request limit, so it is never paged." A burst of live
verification calls (repeated `list_chatgpt_chats`, concurrent `fresh_tab` asks) tripped ChatGPT's
account-wide throttle mid-session, observed directly by Brian in his own ChatGPT UI.

- Treat the mocked unit test suite (`npm test` — fake WebSocket tabs, zero real ChatGPT calls) as the
  primary way to verify a change. It already covers concurrency, pacing, and rate-limit reactions.
- If a live smoke test is genuinely needed, make **at most one** minimal live call per change. Never
  fire multiple concurrent live calls, or repeated `list_chatgpt_chats` calls back to back, just to
  demonstrate something the mock already proves.
- The broker now paces and logs real requests adaptively (`server/index.js`'s `agentPacer`,
  `data/observations/request-timing.jsonl`) — read that log before assuming a fresh burst is safe, and
  after any live call check for `rate_limited: true` in it rather than only trusting the call's own
  return value.
- A restarted broker triggers a full background sync ~60 seconds later
  (`SyncScheduler`'s `firstRunMs`, `server/sync.js`) that makes its own real requests — count that as a
  live call too when reasoning about request volume around a deploy, and check
  the broker log (`journalctl --user -u chatgpt-bridge`, or `data/logs/server.log` when started via
  `scripts/run-server.sh`) for `[sync] FAILED` after any restart.

## Temporary debug surface (remove when done)

`debug_inspect_toolbar` and `debug_click_and_inspect` (`server/index.js`, `extension/content.js`) are
throwaway, read-only reconnaissance endpoints added 2026-09-17 to find ChatGPT's thinking-level UI
control without guessing selectors blind. Not documented as MCP tools, not unit tested (same as the
rest of the browser-automation surface — see README's own note on that). Remove them once
thinking-level control ships as a real feature, or once they're no longer needed.
