#!/bin/bash
set -e

# Configuration
PROJECT_ID="${PROJECT_ID:-lovable-vitana-vers1}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="cloudshell-relay"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "=========================================="
echo "CloudShell Relay Deployment"
echo "=========================================="
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_NAME}"
echo "=========================================="

# Generate API key if not provided
if [ -z "$RELAY_API_KEY" ]; then
  RELAY_API_KEY=$(openssl rand -hex 32)
  echo ""
  echo "Generated API Key (SAVE THIS!):"
  echo "=========================================="
  echo "$RELAY_API_KEY"
  echo "=========================================="
  echo ""
fi

# Set project
echo "Setting GCP project..."
gcloud config set project ${PROJECT_ID}

# Enable required APIs
echo "Enabling required APIs..."
gcloud services enable cloudbuild.googleapis.com run.googleapis.com containerregistry.googleapis.com

# Build the image
echo "Building Docker image..."
cd "$(dirname "$0")"
gcloud builds submit --tag ${IMAGE_NAME}:latest .

# Deploy to Cloud Run
echo "Deploying to Cloud Run..."
gcloud run deploy ${SERVICE_NAME} \
  --image ${IMAGE_NAME}:latest \
  --platform managed \
  --region ${REGION} \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --timeout 300 \
  --min-instances 0 \
  --max-instances 3 \
  --set-env-vars "RELAY_API_KEY=${RELAY_API_KEY}" \
  --set-env-vars "ALLOWED_COMMANDS=gcloud,docker,git,ls,cat,pwd,echo,npm,node,pnpm"

# Get service URL
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format 'value(status.url)')

echo ""
echo "=========================================="
echo "DEPLOYMENT SUCCESSFUL!"
echo "=========================================="
echo ""
echo "Service URL: ${SERVICE_URL}"
echo "API Key: ${RELAY_API_KEY}"
echo ""
echo "Save these values! You'll need them to connect Claude Code."
echo ""
echo "Test with:"
echo "curl ${SERVICE_URL}/health"
echo ""
echo "=========================================="
