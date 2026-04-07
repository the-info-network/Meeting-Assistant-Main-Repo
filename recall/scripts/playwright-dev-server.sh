#!/usr/bin/env bash
# Start the recall app for Playwright: Railway DATABASE_URL + Redis (prefer REDIS_PUBLIC_URL).
# From recall/: bash scripts/playwright-dev-server.sh
set -e
cd "$(dirname "$0")/.."

if [[ "${PLAYWRIGHT_USE_RAILWAY_BACKEND:-1}" == "0" ]] || [[ -n "${CI:-}" ]]; then
  exec npm run dev
fi

if ! command -v railway &>/dev/null; then
  echo "playwright-dev-server: railway CLI not found; set PLAYWRIGHT_USE_RAILWAY_BACKEND=0 or install @railway/cli" >&2
  exec npm run dev
fi

# Railway injects REDIS_PUBLIC_URL for TCP/public Redis; private REDIS_URL uses redis.railway.internal.
exec railway run bash -c 'if [ -n "$REDIS_PUBLIC_URL" ]; then export REDIS_URL="$REDIS_PUBLIC_URL"; fi; exec npm run dev'
