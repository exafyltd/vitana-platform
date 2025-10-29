#!/bin/bash
# VTID: DEV-CICDL-0031
# Deploy Gateway with DevHub SSE Feed to Cloud Run

set -e

echo "🚀 Deploying Gateway with DevHub SSE Feed to Cloud Run..."
echo "VTID: DEV-CICDL-0031"
echo ""

# Configuration
PROJECT_ID="lovable-vitana-vers1"
REGION="us-central1"
SERVICE_NAME="vitana-gateway"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# Set project
gcloud config set project ${PROJECT_ID}

# Build and deploy
echo "📦 Building Docker image..."
cd services/gateway
gcloud builds submit --tag ${IMAGE_NAME}

echo "🚢 Deploying to Cloud Run..."
gcloud run deploy ${SERVICE_NAME} \
  --image ${IMAGE_NAME} \
  --region ${REGION} \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars="NODE_ENV=production" \
  --set-secrets="SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE=SUPABASE_SERVICE_ROLE:latest,SUPABASE_DB_URL=SUPABASE_DB_URL:latest" \
  --memory 512Mi \
  --cpu 1 \
  --timeout 300s \
  --max-instances 10 \
  --min-instances 1

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📡 SSE Feed URL:"
URL=$(gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format='value(status.url)')
echo "${URL}/api/v1/devhub/feed"
echo ""
echo "💚 Health Check:"
echo "${URL}/api/v1/devhub/health"
echo ""
echo "🧪 Test SSE Stream:"
echo "curl -N \"${URL}/api/v1/devhub/feed\""
