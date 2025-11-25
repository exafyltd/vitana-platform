#!/bin/bash
#
# VTID-114: Gateway Supabase Activation & OASIS Ingest Test
# Run this script in Google Cloud Shell
#

set -e

PROJECT="lovable-vitana-vers1"
REGION="us-central1"
SERVICE="gateway"

echo "=========================================="
echo "VTID-114: Gateway Supabase Deployment"
echo "=========================================="
echo ""

# Step 1: Capture current state
echo "📸 Step 1: Capturing current state..."
OLD_REVISION=$(gcloud run services describe $SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --format="value(status.latestReadyRevisionName)")
GATEWAY_URL=$(gcloud run services describe $SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --format="value(status.url)")

echo "   OLD_REVISION: $OLD_REVISION"
echo "   GATEWAY_URL: $GATEWAY_URL"
echo ""

# Step 2: Verify code is current
echo "🔄 Step 2: Pulling latest code..."
cd ~/vitana-platform
git pull origin main
echo ""
echo "Recent commits:"
git log --oneline -10
echo ""

# Step 3: Deploy Gateway
echo "🚀 Step 3: Deploying Gateway..."
cd ~/vitana-platform
./scripts/deploy/deploy-service.sh gateway services/gateway
echo ""

# Step 4: Apply Supabase secrets
echo "🔐 Step 4: Applying Supabase secrets..."
gcloud run services update $SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --set-secrets="SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE=SUPABASE_SERVICE_ROLE:latest"
echo ""

# Step 5: Verify new revision
echo "✅ Step 5: Verifying new revision..."
NEW_REVISION=$(gcloud run services describe $SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --format="value(status.latestReadyRevisionName)")
GATEWAY_URL=$(gcloud run services describe $SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --format="value(status.url)")

echo "   NEW_REVISION: $NEW_REVISION"
echo "   GATEWAY_URL: $GATEWAY_URL"

if [ "$OLD_REVISION" = "$NEW_REVISION" ]; then
  echo "   ⚠️  WARNING: Revision did not change!"
else
  echo "   ✅ New revision deployed successfully"
fi
echo ""

# Step 6-8: Health checks
echo "🏥 Step 6-8: Running health checks..."
echo ""

echo "Test 1: /alive"
curl -s -w "\nHTTP:%{http_code}\n" "$GATEWAY_URL/alive"
echo ""

echo "Test 2: /api/v1/governance/categories"
curl -s -w "\nHTTP:%{http_code}\n" "$GATEWAY_URL/api/v1/governance/categories?limit=1"
echo ""

echo "Test 3: /api/v1/governance/rules"
curl -s -w "\nHTTP:%{http_code}\n" "$GATEWAY_URL/api/v1/governance/rules?limit=1"
echo ""

# Step 9: OASIS ingest test
echo "📥 Step 9: Testing OASIS ingest..."
curl -s -o /tmp/ingest.json -w "\nHTTP:%{http_code}\n" \
  -X POST "$GATEWAY_URL/api/v1/events/ingest" \
  -H "Content-Type: application/json" \
  -d '{
    "vtid": "VTID-114-TEST",
    "type": "deployment_test",
    "status": "info",
    "message": "VTID-114 OASIS ingest verification",
    "payload": { "source": "VTID-114", "test": true }
  }'

echo ""
echo "Ingest response:"
cat /tmp/ingest.json | jq
echo ""

# Step 10: Verify event stored
echo "🔍 Step 10: Verifying event stored..."
curl -s "$GATEWAY_URL/api/v1/events?limit=5" | jq '.[] | select(.vtid == "VTID-114-TEST")'
echo ""

# Step 11: Check logs
echo "📋 Step 11: Checking recent logs..."
gcloud run services logs read $SERVICE \
  --project=$PROJECT \
  --region=$REGION \
  --limit=50
echo ""

echo "=========================================="
echo "✅ VTID-114 Deployment Complete!"
echo "=========================================="
echo ""
echo "Summary:"
echo "  Old Revision: $OLD_REVISION"
echo "  New Revision: $NEW_REVISION"
echo "  Gateway URL: $GATEWAY_URL"
echo ""
echo "Next: Review the output above and verify all tests passed."
