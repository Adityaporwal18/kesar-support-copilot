#!/usr/bin/env bash
# Fail if a tracked file (or the given paths) contains something that looks like a secret.
# Usage: tools/secret_scan.sh [path ...]     (default: all git-tracked files)
set -uo pipefail
cd "$(dirname "$0")/.."
if [ "$#" -gt 0 ]; then FILES=$(find "$@" -type f 2>/dev/null); else FILES=$(git ls-files); fi
HARD='gsk_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{20,}|n8n_api_[A-Za-z0-9]{10,}|BEGIN (RSA |EC )?PRIVATE KEY|Bearer [A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9_-]{20,}|eyJhbGciOi[A-Za-z0-9._-]{20,}'
bad=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in tools/secret_scan.sh|*.png|*.jpg) continue;; esac
  if grep -nE "$HARD" "$f" >/dev/null 2>&1; then
    echo "SECRET PATTERN in $f:"; grep -nE "$HARD" "$f" | cut -c1-80; bad=1
  fi
done <<< "$FILES"
echo "--- words to eyeball (not failures): key / token / secret outside assignment/ ---"
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in assignment/*|tools/secret_scan.sh|*.png|*.jpg|runs/*) continue;; esac
  grep -nHiE '(api[_-]?key|secret|password|private_key)\s*[:=]\s*["'"'"'][^"'"'"']{8,}' "$f" 2>/dev/null | cut -c1-140
done <<< "$FILES"
if [ "$bad" -eq 1 ]; then echo "RESULT: FAIL"; exit 1; fi
echo "RESULT: clean"
