#!/usr/bin/env bash
# Run app + worker locally using .env (e.g. remote REDIS_URL and DATABASE_URL).
# Usage: ./run-local-with-worker.sh
# Ensure recall/.env exists and has REDIS_URL (and DATABASE_URL, etc.).
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
ENV_FILE="recall/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ recall/.env not found."
  echo "   Create it or run: ./run-local-with-railway-db.sh --pull"
  exit 1
fi

# Load env (REDIS_URL, DATABASE_URL, etc.) for this shell and child processes
export $(grep -v '^#' "$ENV_FILE" | xargs)
if [[ -z "$REDIS_URL" ]]; then
  echo "❌ REDIS_URL missing in $ENV_FILE. Run: ./run-local-with-railway-db.sh --pull"
  echo "   (Uses Railway Postgres + Redis public URL — not local redis://127.0.0.1)"
  exit 1
fi
if [[ "$REDIS_URL" == *"railway.internal"* ]]; then
  echo "❌ REDIS_URL points at redis.railway.internal (only works inside Railway)."
  echo "   Re-run: ./run-local-with-railway-db.sh --pull  (expects REDIS_PUBLIC_URL on the project)"
  exit 1
fi
export NODE_ENV="${NODE_ENV:-development}"

WORKER_PID=""
cleanup() {
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    echo ""
    echo "🛑 Stopping worker (PID $WORKER_PID)..."
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "🚀 Starting app + worker (localhost)"
echo "   App:  http://localhost:${PORT:-3003}"
echo "   Redis: ${REDIS_URL}"
echo ""

cd recall
node worker/index.js &
WORKER_PID=$!
sleep 2
if ! kill -0 "$WORKER_PID" 2>/dev/null; then
  echo "❌ Worker failed to start. Check REDIS_URL and logs above."
  exit 1
fi
echo "✅ Worker running (PID $WORKER_PID)"
echo ""

npm run dev
