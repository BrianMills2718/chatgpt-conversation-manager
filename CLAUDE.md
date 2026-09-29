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

## Whose machine this describes

Several sections below describe **Brian's own deployment**, not the product: the `chmod 555` main checkout, the `chatgpt-bridge.service` systemd user unit, the Windows Task Scheduler launcher, and his Chrome profile. None of these ship in this repo. On anyone else's machine, the broker is started with `npm start` (see README "Install"), and a restart means stopping and re-running that command.

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
  `extension/manifest.json`** in the same change. Without a version bump nothing reloads. How it works:
  the broker's `/health` reports the on-disk version, and the extension's background service worker
  (`extension/background.js`) compares it with its own version. If they differ, it calls
  `chrome.runtime.reload()`, and on reload injects the new content script into every open chatgpt.com
  tab (Chrome otherwise leaves open tabs on old code until refreshed). The worker checks on four
  triggers: a `chrome.alarms` alarm every minute (created only when missing), browser startup,
  install/update, and a ping that each ChatGPT tab sends when it connects to the broker (0.7.6+).
  It does not reload again within 5 minutes of its own reload, so a mismatch a reload cannot fix
  does not loop. The broker closes a tab's older socket (code 4001) when the same tab reconnects,
  so superseded code left in the page cannot act on commands twice.
  - **This only works while the worker exists, and it has been lost once.** Brian's Chrome profile
    on disk shows what happened. The first real self-reload (2026-09-26 21:21Z) left the extension
    loaded but with **no registered service worker**: Chrome deleted the old registration, never
    wrote a new one, and cleared the alarm. So 0.7.2 through 0.7.5 each sat on disk unloaded. Why
    Chrome skipped the registration is not known. The same code self-reloads correctly in a
    throwaway profile of Brian's Chrome build from the same `\\wsl.localhost` path. No extension
    code can recover from a missing worker; a manual reload of the extension is the known fix.
  - **A fixed auto-reloader cannot install itself.** When the running copy's worker is gone,
    or the running copy predates a fix to `background.js`, Brian has to reload the extension by hand
    once: chrome://extensions, reload "ChatGPT Conversation Manager Bridge". That applied to 0.7.6.
    The first install into a new browser/profile (Load unpacked + token) also needs Brian.
  - **Verify that a change landed; don't assume.** `GET /health` (broker-local, costs no ChatGPT
    request) lists `extension_versions_running` next to the on-disk `extension_version`, and from
    0.7.6 `extension_background_ok` (`false` = a tab's ping found no worker, so nothing will
    auto-reload; `null` = tab older than 0.7.6). The broker log warns when a tab connects with a
    version different from disk, and when a tab reports no worker. The extension's Errors panel in
    chrome://extensions was not inspected during the 2026-09-26 loss; check it before the manual
    reload if it happens again, because it is where Chrome's reason would be.
- **Only one supervisor may run the broker.** On 2026-09-29 the Windows task below relaunched the broker during a systemd restart gap. It then held the port with old code while systemd crash-looped on `EADDRINUSE`, and merged fixes silently did not take effect. That task is now **disabled**. After any restart, check `systemctl --user status chatgpt-bridge` shows `active (running)`, and that `ss -tlnp | grep 8787` shows systemd's main PID, before trusting that new code is live.
- There's also a supervised Windows Task Scheduler launcher for this same broker (disabled 2026-09-29, see above)
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
