# Handoff to a coding agent

Copy this prompt into Claude Code or Codex:

> Set up https://github.com/BrianMills2718/chatgpt-conversation-manager on this computer so you can send prompts to and read replies from my own ChatGPT browser account. Follow docs/setup.md and docs/agent-setup.md in the checkout. Complete the automated steps, tell me exactly which browser steps I must do, and resume verification afterward. Keep tokens local and hidden. Do not send ChatGPT prompts until I request the first-use smoke test.

## Agent procedure

1. Inspect the OS, Node version (requires 22+), existing checkout, existing coding-agent connection named `chatgpt-bridge`, and whether port 8787 is occupied. Preserve existing configuration; do not silently replace another installation or starter.
2. Clone into a normal local directory if needed. Read the repo's README and CLAUDE.md. Brian's systemd/WSL arrangements in CLAUDE.md are personal deployment details, not installation requirements for this user.
3. Run `npm ci` and `npm run setup`. Setup preserves existing `.env` values, generates a token if missing/placeholder, and writes private `.setup/connection.txt`. Never display that file or `.env` in a tool result or conversation. Read secrets inside a local process, not into the assistant transcript. Git ignores both.
4. Start `npm start` using your environment's persistent terminal facility. Report where it runs and how to stop it. Do not start a second supervisor or turn on scheduled sync. If it cannot outlive your session, explain that the user should leave a terminal running.
5. Register the appropriate coding-agent connection. Use the commands in docs/setup.md; read the token locally without printing it. Preserve other MCP entries. For an existing `chatgpt-bridge` entry, inspect and reconcile it rather than blindly adding a duplicate. For Codex, the setup launcher supplies `CHATGPT_BRIDGE_TOKEN`; explain that a fresh session must be launched via `npm run agent -- codex` from the repo. Verify the installed CLI's help before adapting syntax.
6. Give the person only the browser actions in setup.md step 2, with the actual absolute `extension` folder and `.setup/connection.txt` paths. They must load the extension, sign into ChatGPT, save the local connection settings, and open the agent tab. Browser credentials stay in their browser.
7. Run `npm run doctor`. This performs a real MCP initialize/list-tools/list-connections sequence, checks authentication, and requires an identified agent tab. Report pass/fail counts and exit code. Missing browser steps mean setup is waiting for those steps, not complete.
8. From the actual coding-agent session, call `list_chatgpt_connections`. This confirms the connection is visible to its consumer; doctor's success alone does not prove the agent loaded its configuration.
9. When the user authorizes it, send exactly one `Reply with the single word: pong` ask pinned to their chosen account. Verify the finished response and conversation link. If a prompt was sent but the reply is delayed, read that conversation; do not resend it.

## Completion and boundaries

Setup is connected when doctor passes and the user's actual agent sees an identified agent tab. Live sending is verified only after the authorized single prompt succeeds. State which level was reached.

Node-based setup is portable; Linux setup has been executed. Native Windows and macOS browser onboarding remain unverified. Multi-account use requires separate browser profiles. Real throttle failover and maximum sustainable throughput are not established.

Do not deploy a shared broker, enable full-history downloads, publish tokens, or install machine-wide startup services as part of this handoff. See README for optional advanced operations after first use works.
