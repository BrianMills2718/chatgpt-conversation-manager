# Changelog

## Unreleased, extension 0.9.22

### First-install connection hang made visible

- Chrome 155 holds a website's first connection to a program on the same computer until the person allows it, with no error. The extension now turns the agent-tab label red ("Not connected ... choose Allow") after 8 seconds of waiting, doctor's failing check names the prompt, and `docs/setup.md` has an explicit Allow step. Cause found with a throwaway Chromium profile: connecting took ~2 s on 4 of 4 runs with the check disabled and never completed (13+ runs) with it on.

### Read-only account inventory

- `GET /api/inventory-chats[?account=email]` (bearer token) lists every chat id the account shows: the ordinary paged list and the Project sidebar, kept as separate lists because the ordinary list omits chats filed inside Projects. It writes no archive files and sends no prompts. Project chats are capped at 20 per project (the sidebar rejects 100 with HTTP 422) by the sidebar request; a project at the cap is then paged in full by cursor.
- The response now carries `ordinary_reported_total` (ChatGPT's own `total` from the list pages) and `ordinary_matches_reported_total`: `true`/`false` when compared, `null` when ChatGPT reported no total (unknown, not complete).

## v0.9.19 (2026-09-29), extension 0.9.15

### Same-account requests share a reserved pacing lane

- Concurrent backend actions now reserve their account's slot before dispatch, so parallel asks cannot all pass the same old pacer timestamp and start together.
- `get_reply` keeps local DOM polling responsive, while a broker-issued account permit gates conversation reads and new-chat discovery across tabs.
- The log separates broker-action pacing and concurrency from physical API requests observed on the ChatGPT page. API events include account, endpoint class, HTTP status, start/completion time, and duration without storing endpoint paths, conversation IDs, query strings, headers, or bodies.
- The extension reports the moment a prompt is submitted and when an API-backed reply check begins, so the broker can pace from the actual action time. A bounded offline queue reports a telemetry gap if it ever overflows.
- Unpinned new asks can select the idle connected account with the earliest projected start, factoring in its learned pacing gap and pending work. Explicit-account asks stay pinned; thread-targeted asks remain on their existing path. An `account_route` event links each automatic choice to its ask outcome without recording prompt text.
- A mocked 429 test verifies that a learned cooldown moves the next unpinned ask to another idle account. This verifies routing behavior, not real ChatGPT quota limits or maximum live throughput.

## v0.9.18 (2026-09-29), extension 0.9.14

### "No composer" on continuations: the page's own conversation load was refused by ChatGPT's rate limit

- **Evidence (rph5, 16:44-16:48Z, therakorski, agent tab `aa9bfb28`).**
  - **Not discarded or frozen.** v0.9.16's lifecycle record for both failed sends shows `was_discarded: false`, `freezes: 0`, `autoDiscardable: false`, and `discarded: false, frozen: false` from Chrome.
  - **Account throttled at that moment.** The tab loaded continuation `6abba875` at 16:44:28. The same account's reply reads on another tab were refused with HTTP 429 at 16:45:11 and 16:45:29, and its pacer gap had widened to 28-112 s. The page sat hidden with 0 messages and no composer.
  - **The reload hit the same limit.** It came at 16:45:37, still inside the throttled window, and failed the same way.
  - **Which pages break.** New-chat pages, which load no conversation, kept working hidden throughout, and so did continuations when the account was not throttled (gw3). kw3 and sbl3 (14:37-14:39Z) also fell next to a 429 on that account (14:41:33Z).
  - **Conclusion.** A conversation page renders no messages and no composer until its own `GET /backend-api/conversation/<id>` returns. When ChatGPT refuses that load, the page stays empty. The page being hidden is not what breaks it. Waiting on a rate-limited fetch fits the evidence; hidden-tab rendering and freezing do not.
- **Fix.**
  - **Evidence at failure time.** The no-composer error now reports the page's own load of the conversation from the browser's resource timing (`conversation_fetch`: HTTP status, how long ago, attempts), plus `rendered_messages`. These are logged in `request-timing.jsonl`.
  - **Wait out the limit before reloading.** If a continuation page rendered nothing and its load was refused (or never answered), the broker counts it as the account's rate limit. It widens that account's pacer and waits the gap before reloading, logged as `wait_for_conversation_load`.
  - **Fail fast when there isn't time.** If waiting would exceed the ask's timeout, the ask fails at once: `sent=no`, failure kind `rate_limited`, with the reason stated.
  - Nothing is sent in either case.
- **Not changed, and why.** The alternatives (keeping agent tabs visible or focused, a dedicated window, Chrome flags) would address hidden-tab rendering, which the evidence does not implicate. They would also steal focus from colleagues or need Chrome flags. The next occurrence's `conversation_fetch.status` shows whether the load was refused (429) or never came back.

## v0.9.17 (2026-09-29), extension 0.9.13

### Agent tabs are opened in the right account's browser profile; setup steps use Chrome's exact wording

- **What failed.** The first two-account check (C3) failed with nothing sent. Both asks tried to open an agent tab with `cmd.exe /c start "" chrome https://chatgpt.com/?ccm_agent=1`, which hit the flaky WSL interop call ("UtilAcceptVsock: accept4 failed 110") three times.
  - Even when that command works, it opens Chrome's default or last-used profile. So it can never produce a tab for an account that lives in another profile. Brian's layout: brianmills2718 in his main profile, therakorski in a profile named "ChatGPT 2".
  - Before the second profile existed, the second account had first been signed into the same profile. ChatGPT's account switcher then turned therakorski's agent tabs into brianmills2718 tabs as they reloaded (15:49-15:50Z). The broker saw those tabs as gone and set them aside, which is why the existing agent tabs were not claimed.
- **Fix: open agent tabs from inside the profile.**
  - The broker asks the extension in a tab already signed into the wanted account to open the agent tab (`open_agent_tab`, then `chrome.tabs.create` in that profile). It prefers a human tab, since it is not busy with an ask.
  - The shell command is only a fallback, and it is refused when a specific account is requested, because it cannot choose the profile.
  - With no tab of that account connected, the error says to open `https://chatgpt.com/?ccm_agent=1` in the profile signed into that account, and lists which agent tabs were checked first.
  - This also removes the WSL interop call from the normal path.
- **Setup steps.** Following the old wording, Brian ticked "Enable debug console logging" instead of the archive option. Install step 3 now quotes every label exactly:
  - **Chrome's pages** (checked by loading the extension in Chromium and reading the pages): "Developer mode", "Load unpacked", the card "ChatGPT Conversation Manager Bridge", then "Details" and "Extension options".
  - **The options page** (checked against `extension/options.html`): "Broker WebSocket URL", "Authentication token", "Automatically archive open conversations", "Archive debounce (milliseconds)", "Enable debug console logging", and "Save".
  - **Which boxes to leave alone**, and to type the URL by hand and paste only the token.
  - **"Several accounts and browsers at once"** now requires one Chrome profile per account, and walks through adding one ("Add", "Stay signed out", as Brian's Chrome showed them).
- **Test hardening.** The concurrency test now checks structurally that both prompts reached their tabs before either ask finished. The old wall-time bound failed on a loaded machine.

## v0.9.16 (2026-09-29), extension 0.9.12

### One rule for "this tab is gone": set it aside and move the ask; agent tabs exempt from discarding; lifecycle evidence

- **What happened.** kw3 (14:37Z, tab `9bbe1e65`) navigated to its conversation, found no composer in a hidden page that had rendered 0 messages, reloaded the tab once, and the tab never came back. The ask failed `sent=no` while another agent tab (`82e7de0a`) was alive: v0.9.14 moved asks to another tab only after a failed *navigation*, not after a failed reload. sbl3 (14:39Z, tab `36f8bb42`) failed its fill with "no composer editor on the page". gw3, also a continuation, went through fine in between, so this was intermittent, not a regression from v0.9.15.
- **Class fix.** Every path that ends with a tab that never answers, or never comes back from a page load or reload, is marked `tab_dead`. One rule, `tabGone`, decides whether to move on: the tab is dead AND nothing was typed or dispatched to it. The whole stretch from claiming a tab to handing it the prompt (navigation, send, composer recovery, reload) runs per tab. A gone tab is set aside and the ask starts again on another idle or freshly opened agent tab: at most 3 tabs, one ask per tab. If no other tab becomes available, the ask fails with the original reason plus "No other agent tab became available". A tab that stalls *after* taking the prompt is never abandoned, because it may have sent (`sent=unknown`).
- **Tests.** One per path: dead after navigation, dead after the no-composer reload, and the negative case of a stall after taking the prompt.
- **Why background agent tabs die (evidence gathering, plus one mitigation).** A hidden page that loads with 0 messages and no composer, then never reconnects, fits Chrome discarding or freezing background tabs (Memory Saver, and freezing under Energy Saver).
  - **Mitigation.** Each agent tab now asks the extension's background worker to mark it `autoDiscardable: false`, which exempts it from Memory Saver discarding.
  - **Evidence.** Each page records `document.wasDiscarded`, and counts Chrome `freeze`/`resume` events. These are reported in `get_tab` and on no-composer and fill failures, and logged in `request-timing.jsonl` (`lifecycle`, `stage`, `fill_detail`).
  - **Not proven.** Whether discarding or freezing is the cause. Chrome offers extensions no switch to stop freezing. The next failure's `lifecycle` shows which it is.
- **What ChatGPT says when it rate-limits** (first `api_limit_detail`, 14:41:33Z, a reply check): HTTP 429, body `{"detail":"Too many requests"}`, no `Retry-After` and no `x-ratelimit-*` headers, only `cf-ray`. ChatGPT does not advertise its limits. They can only be inferred from observed refusals, which is why the pacer learns from 429s rather than from advertised values.
- `duration_ms` in `request-timing.jsonl` is rounded again.

## v0.9.15 (2026-09-29), extension 0.9.11

### Continuations no longer read the whole conversation before sending; rate-limit evidence is recorded

- **What was failing.** Five continuation sends failed `sent=no`, all on large audit threads: 12:45:19/:25 (`6abba06c`), 13:16:13 (`6abb9dff`) and 13:47:03/:09 (`6abbaca4`). The pre-send read of the whole conversation (`GET /backend-api/conversation/<id>`) got HTTP 429, and so did the retry 6 s later. Fresh-chat sends and reply checks in between succeeded.
- **What the limit is, from today's evidence (08:00Z onward).**
  - **Endpoint.** Every 429 was on the full conversation read: 6 reply checks (10:35-10:39Z and 11:42Z) and those 5 pre-send reads. The conversation list was also refused once (05:36-05:38Z).
  - **No `Retry-After`.** None of the 429s carried a `Retry-After` value (`api_retry_after_ms` is null on all of them).
  - **Not our request rate.** Counting every read this bridge made in the 10/30/60 minutes before each 429 gives 15-32 / 29-75 / 69-131. The same volumes also occurred without any 429. So it is not a simple per-account request count on our side.
  - **Pattern.** The pre-send failures each came seconds after the tab had navigated to that large conversation (12:45:11, 13:15:45, 13:47:03). By then the page's own load had read it once, and at 13:47 the extension's auto-archive read it three more times within 30 s.
  - **Reading.** That fits a short-window limit on reading the same large conversation repeatedly, possibly weighted by size. The ~31-minute recurrence is the audit's cadence, one continuation every ~31 min, not the limit's window. This is an inference: the counters ChatGPT applies are not visible.
- **Changes.**
  - **No pre-send read.** A continuation no longer reads the conversation before sending. The broker passes the message count it saw when it last read that conversation (`messages_before_hint`). Without one, the reply is found after the user turn that is exactly our prompt (full-text match, not a prefix). A stale hint is tolerated: the reply check looks past older turns for our prompt. Send confirmation for continuations uses the same exact-prompt check. The `no_baseline` failure can no longer happen.
  - **Agent-tab auto-archive deferred.** It now waits until 2 minutes after the page load, instead of adding full reads while the page and the reply checks are already reading.
  - **Limit evidence recorded.** Every refused conversation or list read now records the response's rate-limit headers (`retry-after`, `x-ratelimit-*`, `cf-ray` and similar) and the start of the body. This is `api_limit_detail` in `request-timing.jsonl`, so the next 429 shows what ChatGPT says about the limit.
  - **Waiting on a refused read.** Reply checks already wait rather than fail: the extension's read gap doubles on each 429 up to 60 s, or the `Retry-After` value if one is ever sent.
- **Not done yet.** A per-endpoint pacer. With the pre-send read gone, the only full reads left are the page's own load, the reply checks (already backing off) and the deferred archive. Whether a separate pacer is needed is left to what `api_limit_detail` shows.

## v0.9.14 (2026-09-29)

### An agent tab that does not come back after a page load is set aside; the ask moves on

- **What the v0.9.13 navigation log showed (nb2, 12:03Z).** The ask claimed agent tab `82e7de0a`, which answered normally, and sent it to a new chat (a full page load). The tab's page never reconnected: no socket at all for 60 s, 17 checks, all "not connected". This is the tab that froze earlier today, and it is probably a frozen or Chrome-discarded background tab. A longer wait cannot help, and the old code gave up the whole ask instead of trying another tab.
- **Fix.**
  - **Give up on the tab, not the ask.** If a tab has neither answered nor reconnected `NAV_DEAD_MS` (20 s) after the page load, the ask releases it and sets it aside, logged as `tab_set_aside`. It then claims another idle agent tab, or opens a fresh one, and navigates again. At most three tabs are tried, one ask per tab as before, and nothing is sent meanwhile.
  - **Skip set-aside tabs.** Later asks skip a set-aside tab until it reconnects. Its reconnection shows the page is alive again.
  - **Closing frozen tabs.** The broker cannot close browser tabs itself, because it has no browser tab ids. A frozen tab is therefore ignored, not closed; closing it by hand is harmless.
- The "tab … is not connected" errors on sends are the same condition, a tab mid-reload. Sends already wait up to 20 s for their tab to reconnect (v0.8.3).

## v0.9.13 (2026-09-29)

### New-chat navigation: logged, waited out properly, and diagnosable

- **What happened.** About 1 in 20 new-chat asks failed with "ChatGPT tab never opened a new chat within 20s": a_goodwill at 09:53:39Z and a_webvowl at 10:02:33Z. Nothing was sent. `bridge-events.jsonl` recorded them only as `failure_kind: "unknown"`, with no detail. The 20 s bound was already on the steady clock (v0.9.11 was live from 09:49Z), so the clock steps were not the cause. `navigate_home` is a full page load (`location.href = "https://chatgpt.com/"`), and in a background tab that load, followed by the new page's extension reconnecting, sometimes takes longer than 20 s.
- **Fix.**
  - **Longer bound.** New-chat and continuation navigations now wait up to `NAV_WAIT_MS` (60 s).
  - **One retry.** If the tab is answering again but still on the wrong page halfway through, the navigation is issued once more.
  - **Logging.** Every navigation is logged in `request-timing.jsonl` as `action: "navigate"`, with target, `duration_ms` and `reconnected_after_ms` on the steady clock, number of checks, the last conversation id the tab reported, any last error, and whether it was re-issued.
  - **Failures.** A failure is `failure_kind: "navigation"`, `sent=no`. The message says whether the tab never answered or was still on the old page, and whether a page reload was seen.
- The next occurrence will show whether the page load is just slow, which the longer bound absorbs, or the navigation is being lost, which the re-issue addresses.

## v0.9.12 (2026-09-29)

### A colleague's cold install, fixed from a fresh-clone walkthrough

A fresh clone, followed literally through README "Install" in a clean directory with a new token and no `data/` or `.env`, found these; each is fixed:
- **Node 20.** `npm test` never exited on Node 20.6: every test passed, but the process hung. The minimum is now Node 22 (`engines` in `package.json`, and the README). Node 20 is past end of life.
- **Lockfile.** `package-lock.json` still said 0.3.0, so every install rewrote it. It is regenerated, and `npm audit fix` clears 4 vulnerabilities (1 high). Tests still pass.
- **Port.** Changing the port was only hinted at. Install now says how, and that 8787 below means your port.
- **Second broker.** A second broker on the same port died with a raw `EADDRINUSE` stack trace. It now says the port is in use, that another broker is probably running, and to see "Keeping the broker running".
- **Backup default.** Backup was on by default in `.env.example`. A newcomer's first run downloads every chat for hours on the shared rate limit. The default is now off, with the reason stated. Install also mentions that the extension auto-archives chats you open.
- **Keeping the broker running.** New README section with one supported way (`npm start` in a terminal) and the rule that only one thing may start the broker, with the 2026-09-29 incident as the reason. The README no longer offers remote-mcp's Task Scheduler launcher, which was the second starter in that incident.
- **run-server.sh.** It failed silently when run by hand. It now also prints to the terminal when interactive.
- **Brian-only details moved.** `~/.bashrc` token file, `remote-mcp`, and the private `weekly-plans` repo are now in CLAUDE.md's "Whose machine this describes". Stale version text is fixed. Step 5 has a copy-paste line for Codex's token.
- **Not changed:** `install-windows-startup.sh` still has no uninstall command; its header says which file to delete.

## v0.9.11 (2026-09-29)

### Fixed: flaky timing tests, and pacing and timeouts shortened by wall-clock steps

- **Root cause.** On Brian's WSL machine the wall clock steps forward about 3.6 s every ~30 s. It is correcting drift: measured 2026-09-29, a 180 s run of `Date.now()` against `performance.now()` showed six 3.58 s steps, 21.5 s in total. Every duration in the broker used `Date.now()`, so did the timing tests. A step during a test turned a 700 ms wait into about 4.3 s. The pacer/navigation test ("send waited 3634ms after the page loaded") failed about 1 run in 6: the test's own monotonic duration was 2.2 s while its `Date.now()` span was 5.8 s. The same steps cut pacer gaps, ask timeouts and reply deadlines short in production.
- **Fix.** All broker durations, deadlines and pacer gaps use a monotonic clock (`performance.now()`). Timestamps written to logs still use the wall clock. The timing tests measure with `performance.now()`. Checked: `tests/server.test.js` 14 runs and the full suite 15 runs in a row, with no failure (it failed about 1 run in 6 before).

## v0.9.10 (2026-09-29)

### Root cause of the empty fill: acting on the composer before React hydrates it

- **Evidence.** The live cm3 resend on 0.9.9 (08:41Z, chat `6abb79c7`) arrived verbatim, first click, `prompt_verbatim: true`. On the way, its first fill attempt failed with "no React fiber above the composer", and the retry one second later succeeded. Right after a page load or navigation, the composer element is on the page before React has hydrated it, so a fill in that window acts on nothing. cm3's first attempts (08:32Z) hit that window: 0 characters, then the typed fallback that 0.9.9 removed.
- **Both truncated sends were typed, not filled.** su5 (08:38-08:40Z, 41,495 characters, stored as 273 characters in a ``` fence) and cm3 (08:32-08:37Z) were both logged `fill_mode: "typed"` on 0.9.8. In each, the fill found no live composer and the fallback typed the prompt into the rich composer. There, a typed ``` line starts a code block, and what was submitted ended at the first fence. The `send_prompt` at 08:41:45Z logged `fill_mode: "transaction"` is the cm3 resend. It arrived verbatim (`6abb79c7`), so `fill_mode: "transaction"` has not yet been seen with a truncated result. As a principle, though, `fill_mode` is not proof of a verbatim send. The gate is: since 0.9.9, Send is clicked only if ChatGPT's own `getText()`, the exact submission, equals the prompt.
- **Fix.** The extension waits up to 20 s for the composer to be live. Each attempt re-finds, and re-marks, the element in case hydration replaced it, and two genuine fill mismatches are still allowed. `fill_detail` records any recovered failures. The 0.9.9 gate still refuses to click unless ChatGPT's own `getText()` is the prompt.

## v0.9.9 (2026-09-29)

### Fail closed: Send is clicked only if ChatGPT would submit the prompt verbatim

- **What happened (cm3, 08:32-08:37Z, v0.9.8).** Both one-step fills reported 0 characters in the composer, so the extension fell back to typing, which took 279 s. It then clicked Send, and about 240 of 58,204 characters reached ChatGPT, wrapped in a ``` fence (chat `6abb78ab`). The attribution check correctly refused the answer, but the damage was done: a partial prompt cost quota and got an answer to the wrong question.
- **Gate.** Before clicking Send, the extension reads what ChatGPT itself would submit: the composer controller's own `getText()`, from the page. It clicks only if that equals the prompt exactly, apart from trailing whitespace, which ChatGPT trims. There is no normalization and no unescaping. Otherwise it clears the composer and fails with `refusing to click Send: ChatGPT would not send this prompt verbatim`. The diagnostic gives the first differing position with text from both sides, and the result is `sent=no`. If `getText()` cannot be read, it also refuses.
- **The fill is judged the same way.** It used to be judged by reading the DOM, which on cm3 said 0 characters while something else was sent.
- **Typed fallback removed.** It was slow, and on cm3 it produced the partial send. If the one-step fill fails twice, nothing is sent and the error carries the diagnostic.
- Extension manifest -> 0.9.9.

## v0.9.8 (2026-09-29)

### Fixed: a false refusal, and a prompt delivered wrapped whole in a code fence

- **What happened (ats4, 08:21Z).** The ask continued an older conversation (`6abb4cd7`) after navigating to it. The one-transaction fill did not leave the prompt in the composer, so the extension fell back to typing, which took 187 s for 72k characters. It then switched to plain-text mode. ChatGPT stored the prompt as ```` "````\n" + prompt + "\n````" ````, the whole prompt as one code block, and the bridge refused the reply as not ours. The model answered in the requested format ("NO HIGH-CONFIDENCE BUGS"), so it still read the instructions. But a prompt delivered as one quoted code block is not what was sent, and it can change how the model treats it. My 80k/60k proof (`6abb7399`) did not catch this because both of its sends used the fill path (typing 0.5-0.7 s). Its continuation also needed no navigation, since the tab was already on that conversation.
- **Fix.**
  - **Target the right editor.** The content script now marks the exact editor it uses (`data-ccm-composer`). The page-world fill targets that editor and accepts only the controller whose view is that editor. The likely cause, not yet proven, is that the fill hit a different editor or controller on a page that had just navigated.
  - **Retry and log.** The fill is retried once. Each send logs `fill_mode` and, on a mismatch, `fill_detail`: the first differing position, with text from both sides.
  - **Fallback without the wrap.** If filling fails, typing is still the fallback, but it no longer switches to plain-text mode. That combination is what produced the wrap. The prompt goes out as ChatGPT's Markdown, and the reply says `prompt_verbatim: false`.
  - **Attribution.** A stored copy wrapped whole in a fence longer than any backtick run inside it now counts as ours, but is not verbatim.
- Extension manifest -> 0.9.8.

## v0.9.7 (2026-09-29)

### Fixed at the root: large prompts froze the agent tab

- **Root cause (measured on the live agent tab, without sending).** Typing a prompt with `document.execCommand("insertText")` made ChatGPT's editor process it at about 1.5-3 ms per character in a background tab, in either composer mode: 7-15 s for 5,000 characters, and 20,000 did not finish within 180 s. At 50-80k characters the page's main thread was busy for many minutes, so the tab stopped answering the broker and the ask failed after about 5.5 minutes. This hit ats4, wz7 and ao4 on 2026-09-29. v0.9.1-v0.9.4 blamed plain-text mode; that was wrong, and those releases only moved the switch around. (v0.8.1's 73k send typed quickly only because its page was fresh.)
- **Fix (0.9.6).** The extension fills the draft from the page's own world in ONE editor transaction: one paragraph per line, the same structure typing makes, already in plain-text mode (`composerMainWorld` in `extension/lib/plain-text-mode.js`). 80,261 characters now take 0.55 s in a hidden tab. If that path is unavailable, it falls back to typing. `fill_mode` and `typing_ms` are logged per send.
- **Verified live on 0.9.6, both new chat and continuation:**
  - an 80,261-character fresh-chat prompt answered in 15 s (`send_prompt` 3.8 s, fill 0.52 s);
  - a 60,199-character continuation in the same conversation (`6abb7399`) answered in 12 s.

  Both prompts were full of code fences, `###` headers, indentation, tabs, bare URLs, `<tag>`, `&` and backslashes. Each is stored exactly as sent except for the trailing blank line, which ChatGPT trims. Each conversation has exactly one user turn per send, and both replies came back with `prompt_verbatim: true`.
- **Why some deploys did not take effect.** A second supervisor on Brian's machine, the Windows scheduled task "ChatGPT Bridge (thela)", relaunched the broker during a `systemctl --user restart` gap at 07:35Z. From then on it held the port with older code, and systemd crash-looped on `EADDRINUSE`. The task has been stopped and **disabled**, not deleted: `Enable-ScheduledTask -TaskName 'ChatGPT Bridge (thela)'` undoes it. systemd is the only supervisor again (see CLAUDE.md).
- Removed the temporary typing probe. Extension manifest -> 0.9.7.

## v0.9.4 (2026-09-29)

### Fixed: v0.9.3 still froze on large prompts, because plain-text mode stayed on

- The composer controller lives as long as the page, so plain-text mode switched on for one send stayed on for the next. v0.9.3's "type first, then switch" therefore still typed into a plain-text-mode composer from the second send on. A live 80k-character send froze the tab again (07:11Z), this time reported loudly as a stalled tab with `sent=unknown`. The extension now switches plain-text mode off before typing, and back on after typing, just before Send.
- Extension manifest 0.9.3 -> 0.9.4.

## v0.9.3 (2026-09-29)

### Fixed: large prompts froze the agent tab (v0.9.1/0.9.2 regression)

- **What happened.** v0.9.1 switched the composer to plain-text mode *before* typing, and typing into a plain-text-mode composer is far slower. An 18k-character prompt took 46s, and 50-72k-character audit prompts froze the tab until the broker gave up after about 5.5 minutes with "Timed out waiting for the browser extension". This hit ats4 at 06:46Z and wz7 at 06:53Z; nothing reached ChatGPT. The 0.9.1 proof used a 318-character prompt, too small to show it.
- **Fix.** Type in the normal composer mode, which takes seconds as in v0.8.x. Switch to plain-text mode after typing and before clicking Send: `getText()` only consults the mode at send time. After the switch, the extension checks the draft is still exactly the prompt. If it is not, the composer is cleared and the send fails with nothing sent. `typing_ms` and `plain_mode_ms` are logged per send.
- **A stalled tab is reported as one.** If the tab never answers `send_prompt`, the error now says the tab stopped responding while typing or sending an N-character prompt, and that whether it was sent is unknown (`sent=unknown`), instead of a bare timeout.
- **Verbatim status reaches the caller.** `/api/ask` results carry `prompt_verbatim`, judged from the stored turn, plus `plain_text_mode_error` when the switch failed. The MCP reply says so in a WARNING line. README has a new section, "If prompts stop arriving verbatim".
- Extension manifest 0.9.2 -> 0.9.3.

## v0.9.0–v0.9.2 (2026-09-29)

### Fixed at the source: prompts reached ChatGPT as escaped Markdown

- **Symptom.** 119 of 291 archived audit prompts were stored, and so read by the model, with every literal Markdown character escaped:
  - `\#`, `` \`\`\` ``, `\_`;
  - leading spaces as `&#x20;`;
  - bare URLs as `[url](url)`.

  Code fences and indentation in the code under review were mangled. v0.8.3 only taught attribution to recognize such a copy.
- **Root cause.** Found in ChatGPT's own composer code, read from the page's loaded JavaScript (`getText`/`hasMarkdownFormatting`). When the draft contains any formatting, the composer sends a Markdown serialization of it, and that serializer escapes everything literal. A URL the editor turns into a link is enough, as are other detected formats. Otherwise it sends the text verbatim. The same prompt is escaped, or not, every time, which is what the archive shows. Confirmed live:
  - a small prompt with a bare URL came back escaped (conversation `6abb552b`);
  - the same prompt without the URL came back verbatim (`6abb5573`).
- **Fix.**
  - **The switch.** ChatGPT has a plain-text composer mode (setting `composerPlainTextMode`, "keeps code, Markdown, and links as literal text", off by default), in which the draft is always sent verbatim. Before typing each prompt, the extension now switches the agent tab's own composer controller into that mode. It reaches the controller through React's tree from the page's main world (`extension/lib/plain-text-mode.js`, run by the background worker via `chrome.scripting.executeScript`). The account setting is not changed, so the user's own tabs keep their normal composer.
  - **Logging.** Each send logs `plain_text_mode` in `request-timing.jsonl`: `true`, or the reason the switch failed. A failed switch is not fatal: the send goes ahead as before, and the reply is flagged `prompt_escaped`.
- **Verified live (0.9.1, conversation `6abb5c7a`).** One prompt covered a bare URL, a code fence, `###` and `##` headers, 4-space indentation, a tab, `*` and `1.` list markers, `<tag>`, `&`, a backslash, inline code, `_under_` and `**bold**`. It was stored identical to what was sent, except for the single trailing newline, which ChatGPT trims. Before the fix the same content was stored escaped.
- **Removed** the temporary composer, bundle and storage probes used to find this (v0.8.4–v0.8.9).
- **Fragility.** The switch depends on ChatGPT's internal composer shape: React fiber, a controller with `setPlainTextMode`/`getText`. If ChatGPT changes it, `plain_text_mode` in the logs shows the failure reason, and prompts fall back to escaped Markdown, which is still correctly attributed.

## v0.8.3 (2026-09-29)

### Fixed: false "Refusing to return a reply" on markdown-escaped prompts, and asks failing while the agent tab reloads

Root-caused and built by the audit-owner agent (branch `fix/tab-reconnect-wait`), then reviewed and landed by the bridge owner.

- **False refusal.** v0.8.0's attribution check compared the stored user turn exactly with the sent prompt. But ChatGPT sometimes stores a prompt markdown-escaped:
  - `\#`, `` \` ``, `\_` and similar backslash escapes;
  - leading spaces as `&#x20;`;
  - bare URLs as `[url](url)`.

  This affected 119 of 291 archived audit prompts. On 2026-09-29 it made the bridge refuse the answer to audit prompt wz6 (conversation `6abb4dcf`), which had reached ChatGPT once. A turn now counts as ours if it equals the prompt either as stored or with ChatGPT's escapes undone. Undoing them on the 91 escaped prompts the audit-owner checked gave the sent prompt file exactly. Only the stored side is unescaped, so a prompt's own real backslashes still count. Replies to an escaped prompt carry `prompt_escaped: true`, because the model read the escaped form.
- **Tab reconnect.** A command aimed at an agent tab now waits, up to `TAB_RECONNECT_WAIT_MS` (20s), for that tab to reconnect and report its account. Before, it failed at once with `tab … is not connected` while a continuation's page was reloading. That happened to audit ask pm2 at 05:30:37: the prompt was dispatched 65 ms before the reloaded tab identified itself.
- **Sent flag before any send.** A failure before `send_prompt` reached a tab now reports `sent=no`.
- **Still open:** why ChatGPT escapes some prompts and not others. The same prompt text is escaped, or not, every time it is sent, so the cause is in the content, not timing or tab. The model receives the escaped text, with code fences and indentation mangled. See the next entry once found.
- Extension manifest 0.8.1 -> 0.8.3.

## v0.8.2 (2026-09-29)

### Setup a teammate can follow, and a broker that is safe by default

- **The broker listens only on this computer.** It used to accept connections on every network interface. It now binds to `127.0.0.1` unless `HOST` says otherwise.
- **It refuses to start without a real token.** A missing `RENAMER_TOKEN` used to fall back to `change-me`, which the extension also pre-fills, so anyone on the network could type into the account. The broker now also refuses a placeholder token or one shorter than 16 characters.
- **`npm start` reads `.env`.** It uses `node --env-file=.env`, the same file that `scripts/run-server.sh` uses.
- **README "Install" rewritten as a checked walkthrough.** A fresh-machine run of it found 17 problems: wrong folder name, token lost with the terminal, Windows-only open command, no agent-tab step, Brian-specific paths presented as setup, and no end-to-end check. The new version covers clone, `.env`, start, extension, agent tab, Claude Code and Codex registration, and an end-to-end check. It adds "Using it well", which covers quota, the `sent=` line and large prompts. "Sharing this with a teammate" now states what has and has not been checked.
- **Clearer defaults.** `.env.example` gives macOS, Linux and WSL values for `SYNC_OPEN_CHATGPT_CMD`. CLAUDE.md now marks which sections describe Brian's own machine. `npm run check` also covers `server/sync.js`. `package.json` and the MCP server report the real version.

## v0.8.1 (2026-09-29)

### Fixed: very large prompts whose Send click ChatGPT drops

- **Reproduced live.** After v0.8.0 was deployed, a 73k-character prompt sent from the hidden agent tab (`/api/ask`, 05:02Z) was unconfirmed. After 600s no chat existed on ChatGPT's server (`list_chatgpt_chats`), so the click had been dropped.
- **History.** From 2026-09-26 on, sends at 60k characters or more went unconfirmed 32 of 135 times in hidden tabs and 2 of 12 in visible ones. Under 60k it was 4 of 160. In the 26 misattribution cases the dropped prompt was sent exactly once, by a later click, after as long as 15 minutes. So ChatGPT drops such a click; it does not queue it.
- **Fix.** While a send stays unconfirmed, the broker asks the tab to try again at 30s, 75s and 135s (`RETRY_CLICK_AFTER_MS`). Each try works like this:
  - It first asks ChatGPT's server whether the prompt arrived (the continuation's message count, or a new chat starting with exactly this prompt). If it did, the ask follows that chat and nothing is clicked.
  - Otherwise it clicks Send again, but only if the composer still holds exactly this prompt, Send is enabled, and ChatGPT is not generating.
  - Each try is logged in `bridge-events.jsonl` as `retry_clicks`.
- **Truthful outcome.** An unconfirmed send that never shows up is now reported as `sent=unknown`. v0.8.0 wrongly reported `sent=false`, which tells callers that retrying is safe.
- Extension manifest 0.8.0 -> 0.8.1.

## v0.8.0 (2026-09-29)

### Fixed: replies attributed to the wrong prompt (#27), and sends logged without an account (#28)

- **Root cause of every misattributed reply.** All 28 wrong replies in the 2026-09-27/28 audit (about 195 sends) had the same shape. The reply named a brand-new chat whose only prompt was a *different* ask's text. In 26 of the 28, that other ask had just failed with `Could not confirm the prompt was sent` or `no enabled send button found`; the other 2 were follow-up rounds of the same repo whose ids could not be told apart. Those failures left the prompt sitting in the agent tab's composer. The next ask's `sendPrompt` skipped typing whenever the composer already "included" the new prompt's first 40 characters. Audit prompts share a 117-character header, so it skipped typing and clicked Send on the leftover text, then returned that text's answer as its own. So "unconfirmed" sends mostly did land, but only when the *next* ask clicked Send. Evidence: each chat checked against `data/raw/chats/*.json` and `chatgpt-bug-audit/results.log`.
- **Why the first click failed.** Unconfirmed sends grew with prompt size: none under 40k characters, 10 of 198 asks at 40-70k, and 16 of 48 at 70k or more (`bridge-events.jsonl`, 2026-09-26 onward). ChatGPT did not accept the click on a very large prompt in time. The mechanism inside ChatGPT is not known.
- **Fix, in the extension (0.8.0):**
  - **Typing.** Every ask empties the composer and types its own prompt. Send is clicked only when the composer holds exactly that prompt (whitespace-normalized), not merely its first 40 characters. Leftover text can therefore never be sent by a later ask.
  - **Failures before the click.** Composer not filled, or no enabled Send button: the composer is cleared, and the error says nothing was sent (`sent=no`).
  - **Clicks the page shows nothing for.** The extension first asks ChatGPT's server whether the send arrived:
    - for a continuation, whether the message count grew;
    - for a new chat, whether one of the 5 newest chats starts with exactly this prompt and no other ask has claimed it.
  - **While the page stays blank, the broker keeps watching.** Every 30s it repeats that new-chat search and follows the chat once found. A late-landing send is picked up instead of timing out as "could not confirm".
  - **No second click, and no "not sent" verdict after a click.** ChatGPT can process a queued click seconds later, so the server not having the turn yet proves nothing. (An earlier draft of this change clicked again; an independent review showed that could send twice.)
- **Fix, in reply attribution.** A reply is accepted only when the user turn it follows is exactly this prompt. The broker now passes the whole prompt instead of a 200-character slice, and a new chat's page-only (DOM) answer is checked the same way. If the conversation holds a different prompt, the ask fails at once with `Refusing to return a reply`, rather than returning another prompt's answer.
- **Outcome is machine-readable.** `/api/ask` errors carry `sent`, `thread_id` and `account`. `sent` is `true` (collect the reply, do not resend), `false` (nothing was sent: the failure came before the click, so retrying is safe) or `null` (unknown, including an attribution mismatch). The MCP tool's error text ends with one line: `[sent=yes|no|unknown conversation=<id> account=<email>]`. A mismatch is logged as failure kind `attribution_mismatch`.
- **Account (#28).** An ask that names no account is now paced and logged under the account its agent tab is signed into. Before, it went to the shared `(default)` pacer and was logged with `account: null`. `bridge-events.jsonl` rows now carry `account` and `sent`.
- Extension manifest 0.7.6 -> 0.8.0.

## v0.7.6 (2026-09-27)

### Fixed: the extension stopped reloading itself onto new versions, silently

- **What happened.** Read from Brian's Chrome profile on disk (read-only). The minute alarm fired and the worker called `chrome.runtime.reload()` at 2026-09-26 21:21:21Z. The extension reloaded (its `last_update_time` pref), but Chrome deleted the old service-worker registration and never wrote a new one (`Service Worker/Database`). It also cleared the update alarm and never re-created it (`Extension State`), and the recorded worker events are empty. Since then the extension has had no background worker, so nothing has checked `/health`. 0.7.2 (synced 90s later), 0.7.3, 0.7.4 and 0.7.5 all sat on disk unloaded. The alarm was the only trigger, so nothing reported it.
- **What it was not.** The worker already used `chrome.alarms`, not a timer that an idle worker would drop. The manifest already had `alarms` and `http://localhost/*`, and the version compare is correct. In a throwaway profile the same code self-reloads correctly: Windows Chrome 153 (Brian's build) from the same `\\wsl.localhost` path, and Linux Chrome 154. Why Chrome skipped the new registration in Brian's browser is not known. The extension's Errors panel at chrome://extensions was not inspected.
- **Second trigger.** Every ChatGPT tab now pings the background worker when it connects to the broker (`extension/lib/background-ping.js`). That wakes an idle worker, which checks `/health` at once. The worker also checks on browser startup and on install/update, besides the minute alarm.
- **A missing worker is now visible.** The tab reports whether the ping was answered. If it was not, the broker log warns that the extension cannot update itself and must be reloaded by hand. `GET /health` lists `extension_background_ok` (`false`: no worker; `null`: tab older than 0.7.6). This part needs a broker restart to take effect.
- **The alarm is only created when missing.** Re-creating it on every worker start resets its countdown, so with tab pings waking the worker the alarm would never fire.
- **No reload loop.** The worker does not reload again within 5 minutes of its own reload (stored in `chrome.storage.local`, which survives the reload). This covers a mismatch that a reload cannot fix, such as the broker reading a different checkout's manifest.
- **The fix cannot install itself.** The running browser has no worker, so 0.7.6 needs one manual reload at chrome://extensions. The auto-reload is only proven once a later version bump loads on its own.
- Extension manifest 0.7.5 -> 0.7.6.

## v0.7.5 (2026-09-27)

### Fixed: the composer wait could give up without looking at the page it waited for

- A 02:16:02 no-composer failure took 73.7s against a 15s window, and earlier ones took 49-51s. The wait loop (`while (elapsed < timeout) { check; sleep }`) had no check after its last sleep. In a hidden tab Chrome can throttle timers to about one wake-up a minute, so one sleep overshot the whole window: the loop checked once at t=0, woke about 60s later, and reported "no composer found" without looking again. `waitFor` now lives in `extension/lib/wait-for.js` (unit tested with a throttled fake clock), always checks once after the deadline, and reports how many checks ran. The no-composer error includes that count, so a future failure shows whether throttling was involved.
- This does not explain the failures that took 16-24s (about 15 checks at ~1s each with no composer). Those are still unexplained, and v0.7.4's diagnostics and one-reload recovery remain the answer for them.
- Extension manifest 0.7.4 -> 0.7.5.

## v0.7.4 (2026-09-27)

### Fixed — continuation asks failing with "no ChatGPT composer found"

- **What the evidence shows.** Two of 23 `send_prompt`s after 01:00Z on 2026-09-27 failed this way (01:36:02, 01:46:00), both continuing an existing chat in agent tab `2f14a6ba`. That tab had navigated to the conversation about 2 minutes before each send (01:33:45.5, 01:43:44.7) and did not reload during or after the send; its next reconnect was its next ask. The broker's pacer (108-120s gap after HTTP 429s) caused the 2-minute gap. The socket disconnect/reconnect logged at the failure moment came from the *other* agent tab (`f35d00c0`), which the caller's next ask navigated 40-90ms later. So the page was not mid-reload. It sat for 2 minutes with no composer, and 21 other sends found the same selectors, so this was not a layout change. Both failing navigations happened 10-13s after ChatGPT answered the conversation endpoint with HTTP 429. That points to the page's own conversation load being throttled into a screen with no composer. That is inferred, not observed: the page's DOM at the time was not recorded, and one other continuation navigated 3s after a 429 and succeeded. Nothing was sent: the error comes before any typing, and the thread still had only its original two messages afterwards.
- **Pacer wait moved before the page load.** The pacer gap is now waited out before `navigate_to_thread`/`navigate_home`, not between the page load and the send. This adds no requests and no latency. The send that follows needs no second wait.
- **One bounded recovery.** The extension's no-composer error now says `nothing was typed or sent` and records page facts: path, seconds since load, visibility, rendered message count, and whether the rate-limit banner is showing. It also carries `stage: no_composer`, `nothing_sent: true`, and a per-page-load `page_id` (`get_tab` reports it too). On exactly that report the broker waits out the pacer gap, reloads that tab once (logged as `reload_for_composer` in `request-timing.jsonl`), waits up to 20s for the new page instance on the same conversation, and sends once more. If the composer is still missing, the ask fails saying the tab was reloaded once and nothing was sent. When the rate-limit banner is showing, the broker does not reload and fails right away, also saying nothing was sent. Nothing else is retried, including timeouts, failures after typing began, and errors from older extensions without `nothing_sent`, so a prompt cannot be sent twice.

### Fixed: a continuation could return earlier answers as its reply

- **What happened.** On 2026-09-27 an ask continuing thread `6ab871dc` returned that thread's earlier assistant answer followed by the new one. The tabs were still running extension **0.7.2**, although 0.7.3 had been on disk since 01:00:57Z. In 0.7.2, a failed pre-send conversation read (HTTP 429 was frequent then) fell back to the hidden tab's DOM message count, which is 0 in these tabs. `replyFromTree` then sliced from message 0 and joined every assistant turn. Evidence that 0.7.3 was not running: 0.7.3 doubles its reply-check API-read gap on each 429, but the tabs kept reading every ~10s through 429 streaks (01:33:02/:12/:22/:35, 01:48:07/:17/:30). A 0.7.3 `send_prompt` also carries fields that 0.7.2 lacks.
- **0.7.3's own guard was not enough either.** When the baseline was unknown, it located our turn by the first 40 characters of the prompt. The audit caller's prompts share 117 to 59,906 leading characters with each other, so if the new user message had not reached the tree by the first API read, that guard would have returned the previous answer. A continuation is now **not sent** without the pre-send message count. The error (`stage: no_baseline`) says nothing was typed or sent and carries the 429, which widens the pacer. The broker sends once more after that gap and otherwise fails truthfully. Every continuation reply is therefore read against a known count.
- **Stale extension is now visible.** Each tab reports its running extension version when it connects. `GET /health` lists `extension_versions_running`, `list_chatgpt_connections` rows carry `extension_version`, and the broker log warns when a tab's version differs from the one on disk. Why the automatic reload did not deliver 0.7.3 is not known yet (see CLAUDE.md). Until 0.7.4 is actually running in the browser, neither this fix nor 0.7.3's is live.
- Extension manifest 0.7.3 -> 0.7.4.

## v0.7.3 (2026-09-26)

### Fixed — `ask_chatgpt` waited its full timeout although ChatGPT had already answered

- **Root cause.** A finished reply needed two consecutive "done" polls. Once a thread has a real conversation id, only a conversation-tree (API) read can report "done", and the extension makes at most one such read per ~10s; the 3s polls in between answer `api_waiting` / `api_checked: false`. The broker treated those as "not done" and discarded the done candidate it was confirming, so two consecutive done polls almost never happened (only when an API read itself took >~7s). Evidence, 2026-09-26/27: five serial asks each failed after 900s while `request-timing.jsonl` shows their API reads returning the finished reply (api_status 200 is logged only on the "done" path) about once a minute for the whole 15 minutes, e.g. the new chat sent ~23:44:10 was already done at the 23:44:24 read. (The ~2.5-minute "finish" gap seen in the threads comes from the user message's client-clock timestamp; the thread ids and assistant timestamps show the replies finished within seconds to a minute.)
- **Fix.** Only a poll that actually observed "not finished" (ChatGPT generating, or an API read saying not done) discards a done candidate; a skipped or throttled (HTTP 429) read no longer does. A reply the backend marks `end_turn: true` is returned on the first read with no confirming read. Confirmation past the deadline is bounded (`confirmGraceMs`, 75s).
- **Wrong-answer guard for continued threads.** If the pre-send tree read failed, the extension fell back to the mounted-DOM message count, which a hidden tab can report as 0 — making every earlier answer in the thread part of "the reply". The baseline is now "unknown", and the reply is what follows the user message containing our prompt text (`replyFromTree(tree, null, { expected })`).
- **Fewer wasted reads while throttled.** The reply check's API-read gap doubles on HTTP 429 up to 60s (or the server's Retry-After) and returns to 10s on any other outcome; previously it read every 10s regardless, and five of six reads were 429s.
- Extension manifest 0.7.2 -> 0.7.3.

## v0.7.2 (2026-09-26)

### Fixed — `ask_chatgpt` no longer reports a sent prompt as failed, and says how to collect a late reply

- **False "composer did not clear" failures.** After clicking Send, the extension treated "the composer cleared within 10s" as the only proof of a send. In a hidden (background) agent tab that often does not happen in time, yet the prompt was sent: of the 18 such failures in `request-timing.jsonl` (2026-09-25/26), 14 have a conversation created on ChatGPT's side seconds later (most already answered), and 16 of the 18 ran with no other ask in flight — so the cause was hidden tabs, not concurrent sends. Callers retried every one, producing duplicate chats. A send is now confirmed by any observable consequence (composer cleared, a conversation id assigned, the user turn rendered, or the server-side message count growing — `extension/lib/send-confirm.js`), and otherwise reported as `send_confirmed: false` instead of an error; the broker keeps watching the thread and returns the real reply.
- **Truthful failures.** If nothing ever shows the prompt arrived, the error now starts `Could not confirm the prompt was sent` (failure kind `send_unconfirmed`) instead of claiming it was sent. A timeout after a seen send says `the prompt WAS sent`, names the conversation (taken from the latest poll, not only the send-time id, which is empty for a new chat), says not to resend, and points at `read_chatgpt_chat`.
- **`read_chatgpt_chat` reports whether the latest reply is finished** (`latest reply: finished` / `NOT finished` in the transcript header), so it is the supported way to collect an answer that outlived `timeout_seconds`.
- **Observability.** `bridge-events.jsonl` failures now carry `error_message` (previously no error text was recorded, so failures could not be grouped by cause), send-step UI failures are classified `browser_ui` instead of `unknown`, and `request-timing.jsonl` records `send_confirmed` / `confirmed_by` / `visibility` for each `send_prompt`.
- Decided against serializing sends across tabs: the evidence above shows the false failures happened without concurrency, and nothing in the send path competes for browser focus.

## v0.7.1 (2026-09-25)

### Added

- `GET /api/read/:thread` — REST twin of the `read_chatgpt_chat` MCP tool: full transcript plus generated images saved to `data/images/<thread>/` (base64 stripped from the JSON), for callers that only have `curl`.

### Fixed — `ask_chatgpt` on ChatGPT's new Home layout

- ChatGPT's 2026-09 Home page no longer renders `#prompt-textarea`, so every `send_prompt` failed with "no ChatGPT composer found". `COMPOSER_SELECTORS` now falls back to generic editor selectors (`[data-testid*="composer"] [contenteditable]`, `div.ProseMirror[contenteditable]`, `main [contenteditable][data-placeholder]`, `main [role="textbox"]`, `main textarea`), each still gated by visibility.
- `debug_inspect_toolbar` now also returns `composerSelector` (which selector matched, or null) and `editables` (every textarea / contenteditable / textbox on the page with id, classes, test ids, placeholder, visibility), so the next layout change is diagnosed from a live tab instead of guessed.


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
