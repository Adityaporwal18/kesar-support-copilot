#!/usr/bin/env bash
# Start the pinned local n8n (data in ~/.n8n). Safe to re-run.
set -euo pipefail
T="$HOME/.kesar-tools"
if curl -sf http://localhost:5678/healthz >/dev/null 2>&1; then echo "n8n already running"; exit 0; fi
GENERIC_TIMEZONE=Asia/Kolkata TZ=Asia/Kolkata N8N_DIAGNOSTICS_ENABLED=false \
  nohup "$T/node_modules/.bin/n8n" start > "$T/n8n.log" 2>&1 &
echo $! > "$T/n8n.pid"
for i in $(seq 1 90); do
  if curl -sf http://localhost:5678/healthz >/dev/null 2>&1; then echo "n8n is up at http://localhost:5678"; exit 0; fi
  sleep 1
done
echo "n8n did not become healthy in 90s; see $T/n8n.log" >&2; exit 1
