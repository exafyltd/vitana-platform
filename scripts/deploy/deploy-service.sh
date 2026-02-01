#!/usr/bin/env bash

# Deployment script for Vitana services
# Compliant with SYS-RULE-DEPLOY-L1
# VTID-01125: Added GOOGLE_GEMINI_API_KEY secret binding for ORB
# VTID-01177: Extended to support services/agents/* mappings

set -euo pipefail

# Colors for readability
YELLOW="\033[33m"
GREEN="\033[32m"
RED="\033[31m"
CYAN="\033[36m"
NC="\033[0m"

# =============================================================================
# VTID-01177: Service Path Mappings
# =============================================================================
# Services that don't follow the default services/<service> pattern.
# Format: SERVICE_NAME -> SOURCE_PATH:HEALTH_PATH:CLOUD_RUN_SERVICE
# If CLOUD_RUN_SERVICE differs from SERVICE_NAME, specify it after second colon.
# =============================================================================
declare -A SERVICE_MAPPINGS=(
  ["vitana-verification-engine"]="services/agents/vitana-orchestrator:/health:vitana-verification-engine"
  ["cognee-extractor"]="services/agents/cognee-extractor:/health:cognee-extractor"
)

# =============================================================================
# Resolve service configuration
# =============================================================================
resolve_service_config() {
  local service="$1"
  local source_path_override="${2:-}"

  # Check if there's a mapping for this service
  if [[ -n "${SERVICE_MAPPINGS[$service]:-}" ]]; then
    IFS=':' read -r mapped_path mapped_health mapped_cloud_run <<< "${SERVICE_MAPPINGS[$service]}"
    SOURCE_PATH="${source_path_override:-$mapped_path}"
    HEALTH_PATH="${HEALTH_PATH:-$mapped_health}"
    CLOUD_RUN_SERVICE="${mapped_cloud_run:-$service}"
  else
    # Default: services/<service>
    SOURCE_PATH="${source_path_override:-services/${service}}"
    HEALTH_PATH="${HEALTH_PATH:-/alive}"
    CLOUD_RUN_SERVICE="$service"
  fi
}

# =============================================================================
# Usage
# =============================================================================
usage() {
  echo -e "${YELLOW}Usage: $0 <service_name> [source_path]${NC}"
  echo ""
  echo "Arguments:"
  echo "  service_name   Cloud Run service name (required)"
  echo "  source_path    Override source path (optional, defaults to services/<service>)"
  echo ""
  echo "Environment variables:"
  echo "  ENVIRONMENT    Deployment environment (default: dev-sandbox)"
  echo "  INITIATOR      Who initiated the deploy (default: user)"
  echo "  DEPLOY_TYPE    Type of deployment (default: normal)"
  echo "  HEALTH_PATH    Health check endpoint (default: /alive or service-specific)"
  echo "  GATEWAY_URL    Gateway URL for OASIS recording"
  echo ""
  echo "Supported services with custom mappings:"
  for svc in "${!SERVICE_MAPPINGS[@]}"; do
    IFS=':' read -r path health _ <<< "${SERVICE_MAPPINGS[$svc]}"
    echo "  - $svc -> $path (health: $health)"
  done
  exit 1
}

# =============================================================================
# Main script
# =============================================================================

# Require at least service name
if [[ $# -lt 1 ]]; then
  usage
fi

SERVICE="$1"
SOURCE_PATH_ARG="${2:-}"
ENVIRONMENT="${ENVIRONMENT:-dev-sandbox}"
INITIATOR="${INITIATOR:-user}"
DEPLOY_TYPE="${DEPLOY_TYPE:-normal}"
PROJECT="lovable-vitana-vers1"
REGION="us-central1"

# Resolve configuration
resolve_service_config "$SERVICE" "$SOURCE_PATH_ARG"

echo -e "${CYAN}============================================================${NC}"
echo -e "${CYAN}  VTID-01177: Canonical Deploy Script${NC}"
echo -e "${CYAN}============================================================${NC}"
echo -e "${YELLOW}Resolved configuration:${NC}"
echo -e "  Service:       ${GREEN}${SERVICE}${NC}"
echo -e "  Cloud Run:     ${GREEN}${CLOUD_RUN_SERVICE}${NC}"
echo -e "  Source Path:   ${GREEN}${SOURCE_PATH}${NC}"
echo -e "  Health Path:   ${GREEN}${HEALTH_PATH}${NC}"
echo -e "  Project:       ${PROJECT}"
echo -e "  Region:        ${REGION}"
echo -e "  Environment:   ${ENVIRONMENT}"
echo -e "  Initiator:     ${INITIATOR}"
echo -e "${CYAN}============================================================${NC}"

# =============================================================================
# STEP 0 — Safety checks
# =============================================================================
echo -e "${YELLOW}Verifying source path exists...${NC}"

if [[ ! -d "$SOURCE_PATH" ]]; then
  echo -e "${RED}ERROR: Source path does not exist: ${SOURCE_PATH}${NC}"
  echo -e "${RED}Deployment aborted.${NC}"
  exit 1
fi

# Check for required files (Dockerfile or buildable structure)
if [[ ! -f "${SOURCE_PATH}/Dockerfile" && ! -f "${SOURCE_PATH}/package.json" && ! -f "${SOURCE_PATH}/pyproject.toml" ]]; then
  echo -e "${RED}ERROR: Source path missing buildable files (Dockerfile, package.json, or pyproject.toml)${NC}"
  echo -e "${RED}Deployment aborted.${NC}"
  exit 1
fi

echo -e "${GREEN}Source path verified: ${SOURCE_PATH}${NC}"

# =============================================================================
# STEP 1 — Deploy service using Cloud Run + CI standards
# =============================================================================
echo -e "${YELLOW}Deploying ${CLOUD_RUN_SERVICE} to Cloud Run...${NC}"

# VTID-01125: Gateway requires additional secrets for ORB intelligence
# Secrets are stored in GCP Secret Manager and bound at deploy time
# NOTE: --set-secrets REPLACES all secrets, so we must include ALL required secrets here
if [ "$CLOUD_RUN_SERVICE" = "gateway" ]; then
  echo -e "${YELLOW}VTID-01125: Binding secrets for gateway service...${NC}"
  gcloud run deploy "$CLOUD_RUN_SERVICE" \
    --project "$PROJECT" \
    --region "$REGION" \
    --source "$SOURCE_PATH" \
    --platform managed \
    --allow-unauthenticated \
    --set-env-vars "ENVIRONMENT=${ENVIRONMENT},AUTOPILOT_LOOP_ENABLED=true,GOOGLE_CLOUD_PROJECT=lovable-vitana-vers1" \
    --set-secrets "GOOGLE_GEMINI_API_KEY=GOOGLE_GEMINI_API_KEY:latest,SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE=SUPABASE_SERVICE_ROLE:latest,SUPABASE_ANON_KEY=SUPABASE_ANON_KEY:latest,SUPABASE_JWT_SECRET=SUPABASE_JWT_SECRET:latest,GITHUB_TOKEN=GITHUB_TOKEN:latest,GH_TOKEN=GITHUB_TOKEN:latest,GITHUB_SAFE_MERGE_TOKEN=GITHUB_TOKEN:latest,DEV_AUTH_SECRET=DEV_AUTH_SECRET:latest,DEV_TEST_USER_EMAIL=DEV_TEST_USER_EMAIL:latest,DEV_TEST_USER_PASSWORD=DEV_TEST_USER_PASSWORD:latest,DEV_JWT_SECRET=DEV_JWT_SECRET:latest,PERPLEXITY_API_KEY=PERPLEXITY_API_KEY:latest" \
    --quiet
elif [ "$CLOUD_RUN_SERVICE" = "worker-runner" ]; then
  # VTID-01202: Worker-runner requires gateway URL and Supabase credentials
  # VTID-01206: Worker-runner MUST have min-instances=1 to maintain polling for canonical pipeline
  echo -e "${YELLOW}VTID-01202: Binding secrets for worker-runner service...${NC}"
  echo -e "${YELLOW}VTID-01206: Setting min-instances=1 to prevent scale-to-zero (canonical pipeline requires constant polling)${NC}"
  GATEWAY_URL_VALUE="${GATEWAY_URL:-https://gateway-q74ibpv6ia-uc.a.run.app}"
  gcloud run deploy "$CLOUD_RUN_SERVICE" \
    --project "$PROJECT" \
    --region "$REGION" \
    --source "$SOURCE_PATH" \
    --platform managed \
    --allow-unauthenticated \
    --min-instances=1 \
    --set-env-vars "ENVIRONMENT=${ENVIRONMENT},GATEWAY_URL=${GATEWAY_URL_VALUE}" \
    --set-secrets "SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE=SUPABASE_SERVICE_ROLE:latest" \
    --quiet
elif [ "$CLOUD_RUN_SERVICE" = "cognee-extractor" ]; then
  # VTID-01225: Cognee Extractor - uses Gemini API for entity extraction
  # Internal-only ingress, shares GOOGLE_GEMINI_API_KEY with gateway
  echo -e "${YELLOW}VTID-01225: Deploying Cognee Extractor with Gemini API config...${NC}"
  gcloud run deploy "$CLOUD_RUN_SERVICE" \
    --project "$PROJECT" \
    --region "$REGION" \
    --source "$SOURCE_PATH" \
    --platform managed \
    --no-allow-unauthenticated \
    --ingress internal \
    --set-env-vars "ENVIRONMENT=${ENVIRONMENT},LLM_PROVIDER=gemini,LLM_MODEL=gemini/gemini-2.0-flash,GOOGLE_CLOUD_PROJECT=${PROJECT}" \
    --set-secrets "GOOGLE_GEMINI_API_KEY=GOOGLE_GEMINI_API_KEY:latest" \
    --quiet
  # Note: Internal ingress services in same project can communicate without explicit IAM binding
  echo -e "${GREEN}Cognee Extractor deployed with internal-only ingress.${NC}"
else
  gcloud run deploy "$CLOUD_RUN_SERVICE" \
    --project "$PROJECT" \
    --region "$REGION" \
    --source "$SOURCE_PATH" \
    --platform managed \
    --allow-unauthenticated \
    --set-env-vars "ENVIRONMENT=${ENVIRONMENT}" \
    --quiet
fi

echo -e "${GREEN}Deployment triggered successfully for ${CLOUD_RUN_SERVICE}.${NC}"

# =============================================================================
# STEP 2 — Get service URL and verify deployment
# =============================================================================
echo -e "${YELLOW}Fetching service URL...${NC}"

SERVICE_URL=$(gcloud run services describe "$CLOUD_RUN_SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --format='value(status.url)')

echo -e "${GREEN}Service URL: ${SERVICE_URL}${NC}"

# =============================================================================
# STEP 3 — Post-deploy health check
# =============================================================================

# Check if service has internal-only ingress (can't curl from outside)
INGRESS=$(gcloud run services describe "$CLOUD_RUN_SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --format='value(spec.template.metadata.annotations."run.googleapis.com/ingress")' 2>/dev/null || echo "all")

if [ "$INGRESS" = "internal" ] || [ "$INGRESS" = "internal-and-cloud-load-balancing" ]; then
  echo -e "${YELLOW}Service has internal-only ingress - checking Cloud Run status instead...${NC}"
  # For internal services, verify via Cloud Run API that latest revision is serving
  SERVING_STATUS=$(gcloud run services describe "$CLOUD_RUN_SERVICE" \
    --project "$PROJECT" \
    --region "$REGION" \
    --format='value(status.conditions[0].status)' 2>/dev/null || echo "Unknown")

  if [ "$SERVING_STATUS" = "True" ]; then
    echo -e "${GREEN}Health check PASSED (internal service is serving)${NC}"
  else
    echo -e "${RED}Health check FAILED: Service status is ${SERVING_STATUS}${NC}"
    echo -e "${RED}Check Cloud Run logs: gcloud run services logs read ${CLOUD_RUN_SERVICE} --region=${REGION}${NC}"
    exit 1
  fi
else
  echo -e "${YELLOW}Running post-deploy health check: ${SERVICE_URL}${HEALTH_PATH}${NC}"

  # Wait a moment for service to stabilize
  sleep 5

  if curl -fsS "${SERVICE_URL}${HEALTH_PATH}" -o /tmp/health_response.json; then
    echo -e "${GREEN}Health check PASSED${NC}"
    echo -e "${CYAN}Response:${NC}"
    cat /tmp/health_response.json | jq '.' 2>/dev/null || cat /tmp/health_response.json
    echo ""
  else
    echo -e "${RED}Health check FAILED: ${SERVICE_URL}${HEALTH_PATH}${NC}"
    echo -e "${RED}Deployment may have issues. Check Cloud Run logs.${NC}"
    exit 1
  fi
fi

# =============================================================================
# STEP 4 — Get deployed commit SHA
# =============================================================================
GIT_COMMIT=$(git rev-parse HEAD)
echo -e "${YELLOW}Using git commit: ${GIT_COMMIT}${NC}"

# =============================================================================
# STEP 5 — VTID-0510: Record software version after validator success
# =============================================================================
echo -e "${YELLOW}VTID-0510: Recording software version...${NC}"

# Canonical Dev Sandbox Gateway (LOCKED)
GATEWAY_URL="${GATEWAY_URL:-https://gateway-q74ibpv6ia-uc.a.run.app}"

# Record the deployment version using operator API
if curl -fsS "${GATEWAY_URL}/api/v1/operator/deployments" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg service "$CLOUD_RUN_SERVICE" \
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
  echo -e "${RED}VTID-0510: Failed to record software version (non-fatal).${NC}"
fi

# =============================================================================
# STEP 6 — Summary
# =============================================================================
echo -e "${CYAN}============================================================${NC}"
echo -e "${GREEN}  DEPLOYMENT COMPLETE${NC}"
echo -e "${CYAN}============================================================${NC}"
echo -e "  Service:     ${CLOUD_RUN_SERVICE}"
echo -e "  URL:         ${SERVICE_URL}"
echo -e "  Health:      ${SERVICE_URL}${HEALTH_PATH}"
echo -e "  Git Commit:  ${GIT_COMMIT}"
echo -e "${CYAN}============================================================${NC}"
