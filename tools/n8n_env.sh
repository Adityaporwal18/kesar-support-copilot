#!/usr/bin/env bash
# Source this file:  . tools/n8n_env.sh
# Loads .env into the environment without printing it and puts n8n-cli on PATH.
_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
if [ -f "$_root/.env" ]; then set -a; . "$_root/.env"; set +a; fi
export PATH="$HOME/.kesar-tools/node_modules/.bin:$PATH"
unset _root
