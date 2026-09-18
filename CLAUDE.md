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
  process there (`pgrep -f server/index.js`, kill it, relaunch via `scripts/run-server.sh` in the
  background) — restarting doesn't need any client action.
- A `content.js` (extension) change needs **two** things from Brian, not one: reload the extension in
  `chrome://extensions`, **and** refresh the actual open ChatGPT tab. Reloading the extension alone
  does not reliably re-inject a fresh content script into a tab that was already open — it can keep
  running old code in memory while the extension listing shows the new version. Verify a change
  actually landed via a distinguishing marker in the next response rather than trusting a "done" reply.
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
  `data/logs/server.log` for `[sync] FAILED` after any restart.

## Temporary debug surface (remove when done)

`debug_inspect_toolbar` and `debug_click_and_inspect` (`server/index.js`, `extension/content.js`) are
throwaway, read-only reconnaissance endpoints added 2026-09-17 to find ChatGPT's thinking-level UI
control without guessing selectors blind. Not documented as MCP tools, not unit tested (same as the
rest of the browser-automation surface — see README's own note on that). Remove them once
thinking-level control ships as a real feature, or once they're no longer needed.
