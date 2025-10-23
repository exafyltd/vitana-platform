#!/bin/bash
set -e

PROJECT_ID="lovable-vitana-vers1"
REGION="us-central1"

echo "🔐 Wiring LLM secrets to Cloud Run services..."

SA_NAME="llm-runner"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Creating service account: $SA_EMAIL"
gcloud iam service-accounts create $SA_NAME \
  --display-name="LLM API access for crew services" \
  --project=$PROJECT_ID 2>/dev/null || echo "✓ Service account exists"

echo "Granting Secret Manager access..."
for SECRET in LLM_GEMINI_API_KEY LLM_OPENAI_API_KEY LLM_CLAUDE_API_KEY LLM_GROK_API_KEY; do
  gcloud secrets add-iam-policy-binding $SECRET \
    --member=serviceAccount:$SA_EMAIL \
    --role=roles/secretmanager.secretAccessor \
    --project=$PROJECT_ID \
    --quiet 2>/dev/null || echo "✓ $SECRET already bound"
done

echo "✓ Service account ready: $SA_EMAIL"

SERVICES=("planner-core" "worker-core" "validator-core" "qa-agent" "test-agent" "oasis")

for SERVICE in "${SERVICES[@]}"; do
  echo ""
  echo "Updating $SERVICE..."
  
  if ! gcloud run services describe $SERVICE --region=$REGION --project=$PROJECT_ID &>/dev/null; then
    echo "⚠️  Service $SERVICE not found, skipping..."
    continue
  fi
  
  gcloud run services update $SERVICE \
    --region=$REGION \
    --project=$PROJECT_ID \
    --service-account=$SA_EMAIL \
    --set-env-vars=\
GCP_PROJECT=$PROJECT_ID,\
LLM_GEMINI_SECRET=LLM_GEMINI_API_KEY,\
LLM_OPENAI_SECRET=LLM_OPENAI_API_KEY,\
LLM_CLAUDE_SECRET=LLM_CLAUDE_API_KEY,\
LLM_GROK_SECRET=LLM_GROK_API_KEY \
    --quiet || echo "⚠️  Failed to update $SERVICE"
  
  echo "✓ $SERVICE updated"
done

echo ""
echo "✅ All Cloud Run services wired to LLM secrets"
