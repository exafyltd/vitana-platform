#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------
# 1️⃣ Capture current revision & URL
# -------------------------------------------------
cd ~/vitana-platform
OLD_INFO=$(gcloud run services describe gateway \
  --region=us-central1 \
  --project=lovable-vitana-vers1 \
  --format="value(status.latestReadyRevisionName,status.url)")
OLD_REVISION=$(echo "$OLD_INFO" | cut -f1 -d' ')
GATEWAY_URL=$(echo "$OLD_INFO" | cut -f2 -d' ')
echo "Current revision: $OLD_REVISION"
echo "Current URL: $GATEWAY_URL"

# -------------------------------------------------
# 2️⃣ Rebuild Command Hub frontend (React V2)
# -------------------------------------------------
cd ~/vitana-platform/services/gateway/src/frontend/command-hub
# Use install to generate lockfile if missing
npm install
npm run build
# Verify built assets exist
ls -l index.html styles.css app.js

# -------------------------------------------------
# 3️⃣ Rebuild Gateway service
# -------------------------------------------------
cd ~/vitana-platform/services/gateway
rm -rf dist
npm ci
npm run build

# -------------------------------------------------
# 4️⃣ Deploy via the standard script
# -------------------------------------------------
cd ~/vitana-platform
./scripts/deploy/deploy-service.sh gateway services/gateway

# -------------------------------------------------
# 5️⃣ Verify new revision is live
# -------------------------------------------------
NEW_INFO=$(gcloud run services describe gateway \
  --region=us-central1 \
  --project=lovable-vitana-vers1 \
  --format="value(status.latestReadyRevisionName,status.url)")
NEW_REVISION=$(echo "$NEW_INFO" | cut -f1 -d' ')
NEW_URL=$(echo "$NEW_INFO" | cut -f2 -d' ')
echo "New revision: $NEW_REVISION"
echo "New URL: $NEW_URL"

if [[ "$NEW_REVISION" == "$OLD_REVISION" ]]; then
  echo "❌ Deployment failed – revision did not change."
  exit 1
else
  echo "✅ Deployment succeeded – revision updated."
fi

# -------------------------------------------------
# 6️⃣ Backend verification (must return HTTP 200)
# -------------------------------------------------
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$NEW_URL/api/v1/oasis/tasks?limit=1")
if [[ "$HTTP_STATUS" -ne 200 ]]; then
  echo "❌ Backend verification failed – HTTP $HTTP_STATUS"
  exit 1
fi

echo "✅ Backend endpoint returned HTTP 200"

# -------------------------------------------------
# 7️⃣ Frontend verification (must return HTTP 200 and contain root div)
# -------------------------------------------------
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$NEW_URL/command-hub")
if [[ "$HTTP_STATUS" -ne 200 ]]; then
  echo "❌ Frontend verification failed – HTTP $HTTP_STATUS"
  exit 1
fi

# Check for root div
CONTENT=$(curl -s "$NEW_URL/command-hub")
if [[ "$CONTENT" != *'<div id="root"></div>'* ]]; then
  echo "❌ Frontend verification failed – 'id=\"root\"' not found in HTML"
  exit 1
fi

echo "✅ Frontend endpoint returned HTTP 200 and contains React root"

# -------------------------------------------------
# 8️⃣ All checks passed
# -------------------------------------------------
echo "✅ All verification steps passed. Command Hub V2 is live."
