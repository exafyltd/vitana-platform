#!/usr/bin/env bash
set -euo pipefail

echo "🚀 Deploying Command Hub Tasks UI Integration"
echo "=============================================="

SERVICE_NAME="vitana-dev-gateway"
VTID="dev-commu-cmdtasks-ui"
LAYER="dev"
MODULE="commu"

echo "📦 Service: $SERVICE_NAME"
echo "🎫 VTID: $VTID"
echo ""

cd "$(dirname "$0")"

echo "🔨 Building application..."
npm run build || { echo "❌ Build failed"; exit 1; }

echo "✅ Build complete"
echo ""

echo "☁️  Deploying to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region us-central1 \
  --project lovable-vitana-vers1 \
  --allow-unauthenticated \
  --labels vtid="$VTID",vt_layer="$LAYER",vt_module="$MODULE"

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Deployment successful!"
  echo ""
  echo "🌐 Service URL:"
  gcloud run services describe "$SERVICE_NAME" \
    --region us-central1 \
    --project lovable-vitana-vers1 \
    --format='value(status.url)'
  echo ""
  echo "🧪 Run smoke tests:"
  echo "   bash smoke-test.sh"
else
  echo "❌ Deployment failed"
  exit 1
fi
