#!/usr/bin/env bash
# Starts the broker with scheduled incremental backup, unless one is already
# answering on the port. Launched at Windows logon by the Startup-folder
# script that install-windows-startup.sh writes.
set -euo pipefail
cd "$(dirname "$0")/.."
# The Startup launcher runs hidden, so send everything (including early errors) to a log.
mkdir -p data/logs
exec >> data/logs/launcher.log 2>&1
echo "[$(date -Is)] run-server.sh starting"
# Launched non-interactively (wsl.exe --exec), so nvm from ~/.bashrc is not loaded.
if ! command -v node >/dev/null && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi
command -v node >/dev/null || { echo "node not found (install Node 20+ or nvm)" >&2; exit 1; }
[ -f .env ] || { echo "missing .env (copy .env.example and set RENAMER_TOKEN)" >&2; exit 1; }
set -a; . ./.env; set +a
if curl -sf --max-time 3 "http://localhost:${PORT:-8787}/health" >/dev/null; then
  echo "broker already running on port ${PORT:-8787}"
  exit 0
fi
mkdir -p "${ARCHIVE_DIR:-./data}/logs"
exec node --env-file=.env server/index.js >> "${ARCHIVE_DIR:-./data}/logs/server.log" 2>&1
