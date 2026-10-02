# Set up ChatGPT for your coding agent

This lets Claude Code or Codex send prompts to ChatGPT in your own browser and read the replies. Your chats can also be saved on your computer. Each person installs their own copy and uses their own ChatGPT login.

You need **Node.js 22 or newer**, Git, Chrome or Edge, a ChatGPT account, and Claude Code or Codex. Keep your browser open and computer awake while using it. On Windows, use a WSL terminal for this guide, with Chrome or Edge on Windows. The Node setup helper avoids shell-specific token generation. Linux setup has been checked; macOS and Windows/WSL newcomer onboarding have not been verified end to end. Native Windows coding-agent launchers may need adaptation and are not covered by this guide.

Prefer your coding agent to handle it? Give it [these instructions](agent-setup.md).

## 1. Prepare the local connection

```sh
git clone https://github.com/BrianMills2718/chatgpt-conversation-manager.git
cd chatgpt-conversation-manager
npm ci
npm run setup
```

Setup creates `.env` with a random token and scheduled backup off. Running it again preserves your existing settings and token. It prints the location of `.setup/connection.txt`: open that file locally to get the two extension settings. It contains a private token, so keep it on your computer.

Start the bridge in this terminal and leave it running:

```sh
npm start
```

## 2. Connect your browser

1. Open `chrome://extensions` (Edge: `edge://extensions`). Enable **Developer mode**, choose **Load unpacked**, and select the cloned repo's **extension** folder.
2. On **ChatGPT Conversation Manager Bridge**, choose **Details → Extension options**.
3. Copy **Broker WebSocket URL** and **Authentication token** from your private `.setup/connection.txt` into the matching fields. Click **Save**.
4. Sign in to ChatGPT in this browser profile and open <https://chatgpt.com/?ccm_agent=1>. Leave that tab open. Your agent types here; your ordinary ChatGPT tabs remain yours to use.
5. **Allow local network access.** Recent Chrome asks, on chatgpt.com, whether the site may connect to devices on your local network (the bridge runs on your own computer). Choose **Allow**. Until you do, the extension cannot connect and doctor fails the first browser check. Verified 2026-10-01 on Chrome 155: with that check switched off the extension connected in about 2 seconds; with it on and nobody clicking, the connection hung with no error. If the prompt is gone, open the lock icon in the address bar → Site settings → *Local network access* → Allow.

The extension automatically saves conversations you open by default. Untick **Automatically archive open conversations** in options if you don't want local copies. Scheduled downloads of your full account history are off by default.

In a second terminal, from the repo folder:

```sh
npm run doctor
```

Each check prints PASS or FAIL and a final count. All checks should pass once your browser is connected. This checks the actual coding-agent connection without sending ChatGPT prompts. A failed check names the next setup step.

## 3. Connect Claude Code or Codex

### Codex

Run once (use your port from `.setup/connection.txt` if you changed it):

```sh
codex mcp add chatgpt-bridge --url http://localhost:8787/mcp --bearer-token-env-var CHATGPT_BRIDGE_TOKEN
```

Then launch Codex from this repo with:

```sh
npm run agent -- codex
```

The launcher reads the token without printing it or changing your shell profile. It passes any extra arguments through, for example `npm run agent -- codex --help`. If you already have Codex running, start a fresh session this way to load the new connection.

### Claude Code

Register the bridge once without printing the token, from a Linux, macOS, or WSL terminal:

```sh
node --input-type=module -e "import fs from 'node:fs'; import {parseEnv} from 'node:util'; import {spawnSync} from 'node:child_process'; const e=parseEnv(fs.readFileSync('.env','utf8')); const r=spawnSync('claude',['mcp','add','--scope','user','--transport','http','chatgpt-bridge','http://localhost:'+(e.PORT||8787)+'/mcp','-H','Authorization: Bearer '+e.RENAMER_TOKEN],{stdio:'inherit'}); if(r.error){console.error(r.error.message);} process.exit(r.status??1);"
```

Then start a fresh Claude Code session. If you prefer, have your agent follow [agent-setup.md](agent-setup.md) to do the registration.

### First use

Ask your agent: **“List the connected ChatGPT accounts without sending a prompt.”** You should see your account and an agent tab. Then, when ready, ask: **“Use my connected ChatGPT account to reply with the single word pong.”** This second action uses your ChatGPT quota. A `pong` reply with a conversation link confirms the full path.

## If something fails

- **Node/npm missing or too old:** install Node.js 22+ and reopen your terminal.
- **Broker unavailable:** run `npm start` and leave it running. Restart it after reboot.
- **Port already used:** identify what is using it first. If it is another bridge, use that installation or stop it deliberately. Otherwise change `PORT` in `.env`, rerun setup, update the extension URL and coding-agent URL.
- **Authentication rejected:** rerun setup to refresh the private connection file, then copy its token into extension options. Make sure the broker and agent use this same installation.
- **Extension never connects, no error:** the agent tab shows a red "Not connected" label after about 8 seconds when Chrome is still waiting for you to allow local network access (step 5 above). Allow it and reload the tab.
- **No extension or agent tab:** open ChatGPT in the profile where you loaded the extension. Save options, refresh ChatGPT, and rerun doctor.
- **Tools absent from your agent:** restart that agent after registration. For Codex, launch with `npm run agent -- codex` so the token is available.
- **Throttled:** pause requests and let the account recover. Backup and your own browser activity also consume account capacity.

## Two accounts and what is verified

Use a separate Chrome/Edge profile for each account, install the extension in each, and give both the same local connection settings. Each profile needs its own signed-in agent tab. Switching accounts within one profile changes the account for its other tabs too.

Real concurrent replies from two accounts have been verified. Automatic selection based on each account's pacing is tested with synthetic 429s. A real prompt-level 429 causing a switch and an optimal throughput rate remain unproven. For the offline demo, see [README](../README.md#focused-offline-adaptive-routing-demo).
