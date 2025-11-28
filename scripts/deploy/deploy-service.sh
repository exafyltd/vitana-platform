#!/usr/bin/env bash

# Deployment script for Vitana services
# Compliant with SYS-RULE-DEPLOY-L1

set -euo pipefail

# Colors for readability
YELLOW="\033[33m"
GREEN="\033[32m"
RED="\033[31m"
NC="\033[0m"

SERVICE="$1"
ENVIRONMENT="${ENVIRONMENT:-dev-sandbox}"
INITIATOR="${INITIATOR:-user}"
DEPLOY_TYPE="${DEPLOY_TYPE:-normal}"

echo -e "${YELLOW}Starting deployment for service: ${SERVICE}${NC}"

# STEP 1 — Deploy service using Cloud Run + CI standards
echo -e "${YELLOW}Deploying ${SERVICE} to Cloud Run...${NC}"
gcloud run deploy "$SERVICE" \
  --project lovable-vitana-vers1 \
  --region us-central1 \
  --source "services/${SERVICE}" \
  --platform managed \
  --quiet

echo -e "${GREEN}Deployment triggered successfully for ${SERVICE}.${NC}"

# STEP 2 — Get deployed commit SHA
GIT_COMMIT=$(git rev-parse HEAD)
echo -e "${YELLOW}Using git commit: ${GIT_COMMIT}${NC}"

# STEP 3 — VTID-0510: Record software version after validator success
echo -e "${YELLOW}VTID-0510: Recording software version...${NC}"

# Canonical Dev Sandbox Gateway (LOCKED)
GATEWAY_URL="${GATEWAY_URL:-https://gateway-q74ibpv6ia-uc.a.run.app}"

# Record the deployment version using operator API
if curl -fsS "${GATEWAY_URL}/api/v1/operator/deployments" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg service "$SERVICE" \
    --arg git_commit "$GIT_COMMIT" \
    --arg deploy_type "$DEPLOY_TYPE" \
    --arg initiator "$INITIATOR" \
    --arg environment "$ENVIRONMENT" \
    '{
      service: $service,
      git_commit: $git_commit,
      deploy_type: $deploy_type,
      initiator: $initiator,
      status: "success",
      environment: $environment
    }')"
then
  echo -e "${GREEN}VTID-0510: Software version recorded successfully.${NC}"
else
  echo -e "${RED}VTID-0510: Failed to record software version.${NC}"
  exit 1
fi

echo -e "${GREEN}Deployment + SWV Record complete for ${SERVICE}!${NC}"
