#!/bin/bash
set -e

# Vitana standard deployment script
# Usage: ./scripts/deploy/deploy-service.sh <service-name> <service-path>

SERVICE_NAME="$1"
SERVICE_PATH="$2"

if [ -z "$SERVICE_NAME" ] || [ -z "$SERVICE_PATH" ]; then
  echo "Usage: $0 <service-name> <service-path>"
  echo "Example: $0 oasis-projector services/oasis-projector"
  exit 1
fi

# Load global config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/vt-config.sh"

echo "🚀 Deploying $SERVICE_NAME from $SERVICE_PATH..."
echo "   Project: $PROJECT_ID"
echo "   Region : $REGION"

cd "$SCRIPT_DIR/../.."   # go to repo root
cd "$SERVICE_PATH"

gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format 'value(status.url)')

echo ""
echo "✅ Service Deployed: $SERVICE_NAME"
echo "🌐 URL: $SERVICE_URL"
echo "🕒 Deployed at: $(date -u)"
echo ""
