#!/usr/bin/env bash
# Clear the data rows (not the header) of both tabs. Usage: tools/reset_sheet.sh practice|main
set -euo pipefail
case "${1:-}" in practice|main) ;; *) echo "usage: $0 practice|main" >&2; exit 2;; esac
curl -sS -X POST "http://localhost:5678/webhook/kesar-admin-reset" -H 'Content-Type: application/json' \
  -d "{\"env\":\"$1\",\"confirm\":\"RESET\"}"; echo
