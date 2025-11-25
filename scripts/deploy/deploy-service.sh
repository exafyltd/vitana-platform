#!/bin/bash
# Standard deployment script for Vitana services
# VTID: SYS-RULE-DEPLOY-L1
# Usage: ./scripts/deploy/deploy-service.sh <service-name> <service-path>

set -euo pipefail

# Configuration
PROJECT_ID="lovable-vitana-vers1"
REGION="us-central1"
ENVIRONMENT="${ENVIRONMENT:-dev}"

# Validate arguments
if [ $# -lt 2 ]; then
  echo "Usage: $0 <service-name> <service-path>"
  echo "Example: $0 oasis-projector services/oasis-projector"
  exit 1
fi

SERVICE_NAME="$1"
SERVICE_PATH="$2"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deploying: $SERVICE_NAME${NC}"
echo -e "${GREEN}Path: $SERVICE_PATH${NC}"
echo -e "${GREEN}Environment: $ENVIRONMENT${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Change to service directory
cd "$SERVICE_PATH" || exit 1

# DEV-CICDL-0205: Enforce 17/87 Dev Frontend Spec before deploy
if [ "$SERVICE_NAME" = "gateway" ]; then
  echo "═══════════════════════════════════════════════════════════════════"
  echo "DEV-CICDL-0205: Running Dev frontend navigation spec validator..."
  echo "═══════════════════════════════════════════════════════════════════"
  npm run validate:dev-frontend-spec
  if [ $? -ne 0 ]; then
    echo "❌ Spec validation failed. Aborting deploy."
    exit 1
  fi
  echo "✅ Spec validation passed. Proceeding with deploy..."
fi

# Deploy using gcloud run deploy --source .
echo -e "${YELLOW}Deploying to Cloud Run...${NC}"
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --platform managed \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --timeout 300 \
  --set-env-vars="ENVIRONMENT=$ENVIRONMENT,NODE_ENV=production"

# Get service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format='value(status.url)')

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo "Service: $SERVICE_NAME"
echo "URL: $SERVICE_URL"
echo "Region: $REGION"
echo ""
echo "Test with:"
echo "  curl $SERVICE_URL/alive"
