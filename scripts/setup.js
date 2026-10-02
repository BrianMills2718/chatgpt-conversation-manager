import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const args = process.argv.slice(2);

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer, then retry.');
  if (args.length && !['--check', '--agent'].includes(args[0])) throw new Error('Use npm run setup, npm run doctor, or npm run agent -- codex.');
  if (!args.length) {
    let source = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    const env = parseEnv(source);
    if (!env.RENAMER_TOKEN || ['change-me', 'replace-with-a-long-random-token'].includes(env.RENAMER_TOKEN)) {
      source = source.replace(/^RENAMER_TOKEN=.*(?:\r?\n|$)/m, '');
      source += `\nRENAMER_TOKEN=${randomBytes(24).toString('hex')}\n`;
      fs.writeFileSync(envPath, source, { mode: 0o600 });
    } else if (!fs.existsSync(envPath)) fs.writeFileSync(envPath, source, { mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
  }
  if (!fs.existsSync(envPath)) throw new Error('Run npm run setup first.');
  const env = parseEnv(fs.readFileSync(envPath, 'utf8'));
  if (!env.RENAMER_TOKEN || ['change-me', 'replace-with-a-long-random-token'].includes(env.RENAMER_TOKEN)) throw new Error('Run npm run setup to replace the placeholder token.');
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set PORT in .env to a number from 1 through 65535.');
  const url = `http://localhost:${port}`;
  if (args[0] === '--agent') {
    if (!['codex', 'claude'].includes(args[1])) throw new Error('Choose npm run agent -- codex or npm run agent -- claude.');
    const child = spawn(args[1], args.slice(2), { stdio: 'inherit', env: { ...process.env, CHATGPT_BRIDGE_TOKEN: env.RENAMER_TOKEN } });
    child.once('error', error => { console.error(`Cannot launch ${args[1]}: ${error.message}`); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    return;
  }
  if (args[0] === '--check') {
    let passed = 0;
    let failed = 0;
    const check = (ok, message) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`); ok ? passed++ : failed++; };
    check(true, 'Local .env contains a token (value hidden).');
    check(env.SYNC_INTERVAL_MINUTES === '0', 'Scheduled backup is off; set SYNC_INTERVAL_MINUTES=0 for first setup.');
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      const health = await response.json();
      check(response.ok && health.ok === true, `Broker answers at ${url}.`);
      check(Number(health.extension_connections) > 0, 'Extension connected; open ChatGPT after saving extension options. If the ChatGPT tab shows a red "Not connected" label or Chrome asks to allow chatgpt.com to connect to devices on your local network, choose Allow, then rerun doctor.');
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const client = new Client({ name: 'setup-doctor', version: '1.0.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${env.RENAMER_TOKEN}` } } }));
        check(true, 'Coding-agent connection accepts this installation’s token.');
        const tools = await client.listTools();
        check(tools.tools.some(tool => tool.name === 'ask_chatgpt'), 'ChatGPT tools advertised to coding agents.');
        const connections = await client.callTool({ name: 'list_chatgpt_connections', arguments: {} });
        const text = connections.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '';
        check(!connections.isError && /\bagent\s+account\s+\S+@\S+/.test(text), 'Agent tab identified; open https://chatgpt.com/?ccm_agent=1.');
      } finally { await client.close(); }
    } catch (error) { check(false, `Broker check could not finish (${error.message}); run npm start in another terminal.`); }
    console.log(`Checks: ${passed} passed, ${failed} failed; exit ${failed ? 1 : 0}. No ChatGPT prompts sent.`);
    process.exitCode = failed ? 1 : 0;
    return;
  }
  const privateDir = path.join(root, '.setup');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const details = path.join(privateDir, 'connection.txt');
  fs.writeFileSync(details, `PRIVATE — keep on this computer. Do not paste into chat, screenshots, or Git.\n\nBroker WebSocket URL: ws://localhost:${port}/extension\nAuthentication token: ${env.RENAMER_TOKEN}\n\nCodex registration (contains no token):\ncodex mcp add chatgpt-bridge --url ${url}/mcp --bearer-token-env-var CHATGPT_BRIDGE_TOKEN\n\nThen start Codex with: npm run agent -- codex\n`, { mode: 0o600 });
  fs.chmodSync(details, 0o600);
  console.log(`Setup ready. Existing settings preserved. Token hidden.\nPrivate extension details: ${details}\nNext: npm start in another terminal, then follow docs/setup.md.\nCheck progress: npm run doctor\nScheduled backup: ${env.SYNC_INTERVAL_MINUTES === '0' ? 'off' : 'enabled — turn it off for first setup'}.`);
}

main().catch(error => { console.error(`Setup failed: ${error.message}`); process.exitCode = 1; });
