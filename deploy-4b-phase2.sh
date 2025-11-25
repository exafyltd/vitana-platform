#!/bin/bash
# Task 4B Phase 2 Deployment Script
# VTID: VTID-2025-4B02
# Deploys Events API backend changes

set -e

echo "🚀 Task 4B Phase 2 - Events API Deployment"
echo "=========================================="

# Configuration
PROJECT_ID="lovable-vitana-vers1"
REGION="us-central1"
SERVICE="vitana-gateway"
SUPABASE_URL="${SUPABASE_URL:-https://inmkhvwdcuyhnxkgfvsb.supabase.co}"

# Step 1: Apply database migration
echo ""
echo "📊 Step 1: Applying OASIS events table migration..."
if [ -z "$SUPABASE_SERVICE_ROLE" ]; then
  echo "❌ Error: SUPABASE_SERVICE_ROLE environment variable not set"
  exit 1
fi

# Apply migration via Supabase SQL editor or psql
echo "ℹ️  Please apply migration manually in Supabase SQL editor:"
echo "   File: prisma/migrations/20251028_oasis_events.sql"
read -p "Press Enter when migration is applied..."

# Step 2: Insert seed data
echo ""
echo "🌱 Step 2: Inserting seed data..."
echo "ℹ️  Please run seed SQL in Supabase SQL editor:"
echo "   File: seed-test-event.sql"
read -p "Press Enter when seed data is inserted..."

# Step 3: Build and deploy Gateway
echo ""
echo "🏗️  Step 3: Building and deploying Gateway service..."
cd services/gateway

gcloud run deploy $SERVICE \
  --source . \
  --platform managed \
  --region $REGION \
  --project $PROJECT_ID \
  --allow-unauthenticated \
  --set-env-vars "SUPABASE_URL=$SUPABASE_URL,SUPABASE_SERVICE_ROLE=$SUPABASE_SERVICE_ROLE"

cd ../..

# Step 4: Verify deployment
echo ""
echo "✅ Step 4: Verifying deployment..."
GATEWAY_URL="https://$SERVICE-86804897789.$REGION.run.app"

echo "Testing GET /events endpoint..."
curl -s "$GATEWAY_URL/events?limit=5" | jq '.'

echo ""
echo "Testing GET /events/health endpoint..."
curl -s "$GATEWAY_URL/events/health" | jq '.'

echo ""
echo "=========================================="
echo "✅ Task 4B Phase 2 deployment complete!"
echo ""
echo "📊 Endpoints available:"
echo "  GET  $GATEWAY_URL/events"
echo "  POST $GATEWAY_URL/events/ingest"
echo "  GET  $GATEWAY_URL/events/health"
echo ""
echo "🎯 Next: Task 4B Phase 3 - Frontend integration"
