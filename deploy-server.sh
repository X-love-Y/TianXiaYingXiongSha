#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 20 or newer first."
  exit 1
fi

export WEB_AI_GAME_HOST="${WEB_AI_GAME_HOST:-0.0.0.0}"
export WEB_AI_GAME_PORT="${WEB_AI_GAME_PORT:-8000}"
export LLM_PROVIDER="${LLM_PROVIDER:-deepseek}"
export DEEPSEEK_MODEL="${DEEPSEEK_MODEL:-deepseek-chat}"

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "DEEPSEEK_API_KEY is not configured. The game will use local fallback generation."
fi

exec node dev-server.cjs
