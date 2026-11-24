#!/usr/bin/env bash
# Stop the local n8n started by tools/start_n8n.sh.
set -euo pipefail
T="$HOME/.kesar-tools"
if [ -f "$T/n8n.pid" ] && kill -0 "$(cat "$T/n8n.pid")" 2>/dev/null; then
  kill "$(cat "$T/n8n.pid")"; rm -f "$T/n8n.pid"; echo "n8n stopped"
else
  echo "n8n not running (no live pid)"
fi
