#!/usr/bin/env bash
# Run the app on localhost using the Railway remote database.
# Pulls env from Railway (current linked project/service) into recall/.env, then starts the app.
# Usage: ./run-local-with-railway-db.sh   [pull and start, or start if .env exists]
#        ./run-local-with-railway-db.sh --pull   [force pull from Railway then start]
#
# One-time: railway login && railway link && railway service <your-main-service>
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
ENV_FILE="recall/.env"
# Use Railway CLI if in PATH, otherwise npx (no global install needed)
RAILWAY_CMD="$(command -v railway 2>/dev/null || echo "npx -y @railway/cli")"

pull_from_railway() {
  if command -v railway &> /dev/null || command -v npx &> /dev/null; then
    :
  else
    echo "❌ Railway CLI not found. Install: npm i -g @railway/cli  (or use: sudo npm i -g @railway/cli)"
    exit 1
  fi
  if ! $RAILWAY_CMD whoami &> /dev/null; then
    echo "❌ Not logged in. Run: $RAILWAY_CMD login"
    exit 1
  fi
  if ! $RAILWAY_CMD status &> /dev/null; then
    echo "❌ Project not linked. Run: $RAILWAY_CMD link && $RAILWAY_CMD service <service-name>"
    exit 1
  fi

  echo "Pulling env from Railway into recall/.env..."
  $RAILWAY_CMD variables --json > /tmp/railway-vars.json 2>&1 || { echo "❌ Failed to fetch Railway variables"; exit 1; }

  if command -v jq &> /dev/null; then
    DATABASE_URL=$(jq -r '.DATABASE_URL // empty' /tmp/railway-vars.json)
    RECALL_API_KEY=$(jq -r '.RECALL_API_KEY // empty' /tmp/railway-vars.json)
    RECALL_API_HOST=$(jq -r '.RECALL_API_HOST // empty' /tmp/railway-vars.json)
    SECRET=$(jq -r '.SECRET // empty' /tmp/railway-vars.json)
  else
    DATABASE_URL=$(node -e "const v=require('/tmp/railway-vars.json');console.log(v.DATABASE_URL||'')")
    RECALL_API_KEY=$(node -e "const v=require('/tmp/railway-vars.json');console.log(v.RECALL_API_KEY||'')")
    RECALL_API_HOST=$(node -e "const v=require('/tmp/railway-vars.json');console.log(v.RECALL_API_HOST||'')")
    SECRET=$(node -e "const v=require('/tmp/railway-vars.json');console.log(v.SECRET||'')")
  fi

  if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL not found in Railway. Add PostgreSQL to the project or link the correct service."
    exit 1
  fi

  # Redis from localhost must use public URL (REDIS_PUBLIC_URL), not redis.railway.internal
  REDIS_URL=""
  if node "$SCRIPT_DIR/recall/scripts/resolve-railway-redis-local.mjs" /tmp/railway-vars.json > /tmp/railway-redis-local.txt 2>/tmp/railway-redis-local.err; then
    REDIS_URL=$(cat /tmp/railway-redis-local.txt)
  else
    echo "❌ Could not resolve a Redis URL for localhost:"
    cat /tmp/railway-redis-local.err
    exit 1
  fi

  mkdir -p recall
  cat > "$ENV_FILE" << EOF
# From Railway (run-local-with-railway-db.sh) — DATABASE_URL + Redis usable from your machine
DATABASE_URL=$DATABASE_URL
REDIS_URL=$REDIS_URL
RECALL_API_KEY=$RECALL_API_KEY
RECALL_API_HOST=$RECALL_API_HOST
PUBLIC_URL=http://localhost:3003
SECRET=$SECRET
NODE_ENV=development
PORT=3003
EOF
  echo "✅ Wrote $ENV_FILE (PUBLIC_URL set to http://localhost:3003 for local dev)."
}

if [[ ! -f "$ENV_FILE" ]] || [[ "${1:-}" == "--pull" ]]; then
  pull_from_railway
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ recall/.env not found. Run: ./run-local-with-railway-db.sh --pull"
  exit 1
fi

echo "🚀 Starting app on localhost with Railway DATABASE_URL + Redis (public URL)"
echo "   Main: http://localhost:3003"
echo "   To run app + worker together (same queue): ./run-local-with-worker.sh"
echo "   Or in another terminal: cd recall && npm run dev:worker"
echo ""
cd recall
npm run dev
