#!/bin/bash
# Script to set up localhost environment with Railway database

set -e

# Run from project root (directory containing recall/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🚀 Setting up Localhost with Railway Database"
echo "=============================================="
echo ""

# Check if Railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI not found. Install it with: npm i -g @railway/cli"
    exit 1
fi

# Link to service
echo "📋 Linking to Railway service..."
railway service v2-demo-worker 2>&1 || {
    echo "⚠️  Could not link to v2-demo-worker, trying to find service..."
    railway status
    echo ""
    echo "Please run: railway service <service-name>"
    exit 1
}

echo ""
echo "📥 Fetching environment variables from Railway..."
echo ""

# Get variables in JSON format
railway variables --json > /tmp/railway-vars.json 2>&1 || {
    echo "❌ Failed to fetch variables"
    exit 1
}

# Extract key variables using jq (if available) or node
if command -v jq &> /dev/null; then
    DATABASE_URL=$(jq -r '.DATABASE_URL // empty' /tmp/railway-vars.json)
    RECALL_API_KEY=$(jq -r '.RECALL_API_KEY // empty' /tmp/railway-vars.json)
    RECALL_API_HOST=$(jq -r '.RECALL_API_HOST // empty' /tmp/railway-vars.json)
    PUBLIC_URL=$(jq -r '.PUBLIC_URL // empty' /tmp/railway-vars.json)
    SECRET=$(jq -r '.SECRET // empty' /tmp/railway-vars.json)
elif command -v node &> /dev/null; then
    DATABASE_URL=$(node -e "const vars=require('/tmp/railway-vars.json');console.log(vars.DATABASE_URL||'')")
    RECALL_API_KEY=$(node -e "const vars=require('/tmp/railway-vars.json');console.log(vars.RECALL_API_KEY||'')")
    RECALL_API_HOST=$(node -e "const vars=require('/tmp/railway-vars.json');console.log(vars.RECALL_API_HOST||'')")
    PUBLIC_URL=$(node -e "const vars=require('/tmp/railway-vars.json');console.log(vars.PUBLIC_URL||'')")
    SECRET=$(node -e "const vars=require('/tmp/railway-vars.json');console.log(vars.SECRET||'')")
else
    echo "⚠️  jq or node not found. Please install jq or use manual setup."
    echo "   See QUICK-LOCALHOST-SETUP.md for manual instructions"
    exit 1
fi

if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL not found in Railway variables"
    echo "   Check Railway dashboard to ensure PostgreSQL is set up"
    exit 1
fi

if ! node "$SCRIPT_DIR/recall/scripts/resolve-railway-redis-local.mjs" /tmp/railway-vars.json > /tmp/railway-redis-local.txt 2>/tmp/railway-redis-local.err; then
    echo "❌ Redis for localhost:"
    cat /tmp/railway-redis-local.err
    exit 1
fi
REDIS_URL=$(cat /tmp/railway-redis-local.txt)

echo "✅ Found environment variables (Railway DB + Redis URL usable from this machine)"
echo ""

# Create .env file
ENV_FILE="recall/.env"

echo "📝 Creating .env file at $ENV_FILE..."
echo ""

cat > "$ENV_FILE" << EOF
# Database (from Railway)
DATABASE_URL=$DATABASE_URL

# Redis: public URL for local dev (REDIS_PUBLIC_URL from Railway, not redis.railway.internal)
REDIS_URL=$REDIS_URL

# Recall API
RECALL_API_KEY=$RECALL_API_KEY
RECALL_API_HOST=$RECALL_API_HOST

# Application
PUBLIC_URL=http://localhost:3003
SECRET=$SECRET
NODE_ENV=development
PORT=3003

# OAuth (add these manually if needed)
# GOOGLE_CALENDAR_OAUTH_CLIENT_ID=
# GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET=
# MICROSOFT_OUTLOOK_OAUTH_CLIENT_ID=
# MICROSOFT_OUTLOOK_OAUTH_CLIENT_SECRET=
EOF

echo "✅ Created $ENV_FILE"
echo ""

# Check if .gitignore includes .env
if ! grep -q "^\.env$" recall/.gitignore 2>/dev/null; then
    echo "⚠️  Warning: .env might not be in .gitignore"
    echo "   Make sure to add .env to .gitignore to avoid committing secrets"
fi

echo ""
echo "📋 Next Steps:"
echo "=============="
echo ""
echo "1. Install dependencies:"
echo "   cd recall && npm install"
echo ""
echo "2. Start the application:"
echo "   npm run dev          # Main app"
echo "   npm run dev:worker   # Worker service"
echo ""
echo "3. Verify connection:"
echo "   Check logs for 'Database connection established'"
echo ""
echo "✅ Setup complete!"
echo ""
echo "💡 Note: SSL is automatically enabled for Railway database connections"
echo ""

