#!/usr/bin/env bash
# VTID-01125: Fix ORB "GOOGLE_GEMINI_API_KEY not configured" error
# This script binds the Gemini API key secret to the Gateway Cloud Run service
#
# Prerequisites:
# 1. gcloud CLI authenticated with appropriate permissions
# 2. Secret 'google-gemini-api-key' must exist in GCP Secret Manager
#
# Usage:
#   ./scripts/deploy/fix-gateway-gemini-secret.sh
#
# If the secret doesn't exist yet, create it first:
#   echo -n "YOUR_API_KEY" | gcloud secrets create google-gemini-api-key --data-file=- --project lovable-vitana-vers1

set -euo pipefail

# Configuration
PROJECT="lovable-vitana-vers1"
REGION="us-central1"
SERVICE="gateway"

# Colors
YELLOW="\033[33m"
GREEN="\033[32m"
RED="\033[31m"
NC="\033[0m"

echo -e "${YELLOW}VTID-01125: Fix Gateway GOOGLE_GEMINI_API_KEY${NC}"
echo ""

# Step 1: Confirm current gateway state
echo -e "${YELLOW}Step 1: Confirming current gateway URL and revision...${NC}"
CURRENT_URL=$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --format='value(status.url)' 2>/dev/null || echo "NOT_FOUND")

CURRENT_REVISION=$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --format='value(status.latestReadyRevisionName)' 2>/dev/null || echo "NOT_FOUND")

echo "Gateway URL: $CURRENT_URL"
echo "Current Revision: $CURRENT_REVISION"
echo ""

# Step 2: Check for required secrets in Secret Manager
echo -e "${YELLOW}Step 2: Checking required secrets in Secret Manager...${NC}"

REQUIRED_SECRETS=(
  "google-gemini-api-key"
  "supabase-url"
  "supabase-service-role"
)

MISSING_SECRETS=()

for secret in "${REQUIRED_SECRETS[@]}"; do
  if gcloud secrets describe "$secret" --project "$PROJECT" &>/dev/null; then
    echo -e "${GREEN}✓ Secret exists: $secret${NC}"
  else
    echo -e "${RED}✗ Secret missing: $secret${NC}"
    MISSING_SECRETS+=("$secret")
  fi
done

if [ ${#MISSING_SECRETS[@]} -gt 0 ]; then
  echo ""
  echo -e "${RED}ERROR: Missing secrets. Create them first:${NC}"
  for secret in "${MISSING_SECRETS[@]}"; do
    echo "  gcloud secrets create $secret --data-file=<path-to-secret-file> --project $PROJECT"
  done
  exit 1
fi
echo ""

# Step 3: Update Cloud Run service with secrets
echo -e "${YELLOW}Step 3: Binding secrets to Cloud Run service...${NC}"

gcloud run services update "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --set-secrets "GOOGLE_GEMINI_API_KEY=google-gemini-api-key:latest,SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_ROLE=supabase-service-role:latest" \
  --quiet

echo ""

# Step 4: Verify new revision
echo -e "${YELLOW}Step 4: Verifying new revision...${NC}"
NEW_REVISION=$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --format='value(status.latestReadyRevisionName)')

echo "Previous Revision: $CURRENT_REVISION"
echo "New Revision: $NEW_REVISION"

if [ "$CURRENT_REVISION" = "$NEW_REVISION" ]; then
  echo -e "${YELLOW}Warning: Revision unchanged. Service may need a full redeploy.${NC}"
fi
echo ""

# Step 5: Test /alive endpoint
echo -e "${YELLOW}Step 5: Testing /alive endpoint...${NC}"
ALIVE_RESPONSE=$(curl -sS "$CURRENT_URL/alive" 2>&1 || echo '{"error":"failed"}')
echo "Response: $ALIVE_RESPONSE"
echo ""

# Step 6: Test ORB endpoint
echo -e "${YELLOW}Step 6: Testing ORB /start endpoint...${NC}"
SESSION_RESPONSE=$(curl -sS -X POST "$CURRENT_URL/api/v1/orb/start" \
  -H "Content-Type: application/json" \
  -d '{"tenant":"vitana","role":"member","route":"community"}' 2>&1 || echo '{"error":"failed"}')
echo "Session Response: $SESSION_RESPONSE"

SESSION_ID=$(echo "$SESSION_RESPONSE" | jq -r '.sessionId // empty' 2>/dev/null || echo "")

if [ -n "$SESSION_ID" ]; then
  echo ""
  echo -e "${YELLOW}Step 7: Testing ORB /text endpoint...${NC}"
  TEXT_RESPONSE=$(curl -sS -X POST "$CURRENT_URL/api/v1/orb/text" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"$SESSION_ID\",\"text\":\"Hello, test\"}" 2>&1 || echo '{"error":"failed"}')
  echo "Text Response: $TEXT_RESPONSE"

  # Check if the error is still present
  if echo "$TEXT_RESPONSE" | grep -q "GOOGLE_GEMINI_API_KEY not configured"; then
    echo ""
    echo -e "${RED}ERROR: GOOGLE_GEMINI_API_KEY still not configured after update.${NC}"
    echo "The service may need a full rebuild. Try:"
    echo "  ./scripts/deploy/deploy-service.sh gateway services/gateway"
    exit 1
  elif echo "$TEXT_RESPONSE" | jq -e '.ok == true' &>/dev/null; then
    echo ""
    echo -e "${GREEN}SUCCESS: ORB endpoint is now working!${NC}"
  fi
fi

echo ""
echo -e "${GREEN}VTID-01125: Fix complete.${NC}"
echo "Gateway URL: $CURRENT_URL"
echo "New Revision: $NEW_REVISION"
