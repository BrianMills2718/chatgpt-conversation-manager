#!/usr/bin/env bash
# Writes a hidden-window launcher into the Windows Startup folder so the broker
# (and its scheduled backup) starts at every Windows logon. Run from WSL.
# Undo: delete the printed .vbs file.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
distro="${WSL_DISTRO_NAME:?not running inside WSL}"
startup_win="$(cmd.exe /c 'echo %APPDATA%' 2>/dev/null | tr -d '\r')\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"
startup="$(wslpath "$startup_win")"
target="$startup/chatgpt-conversation-backup.vbs"
cat > "$target" <<EOF
' Starts the ChatGPT conversation backup broker inside WSL, hidden.
' Installed by $repo/scripts/install-windows-startup.sh
CreateObject("WScript.Shell").Run "wsl.exe -d $distro -u $(id -un) --exec bash $repo/scripts/run-server.sh", 0, False
EOF
echo "$target"
