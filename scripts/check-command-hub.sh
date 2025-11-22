#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL=$(gcloud run services describe gateway \
  --region=us-central1 \
  --project=lovable-vitana-vers1 \
  --format="value(status.url)")

URL="$GATEWAY_URL/command-hub/"

echo "Checking Command Hub at: $URL"

# Follow redirects (-L) and capture final status
STATUS=$(curl -L -s -o /tmp/ch.html -w '%{http_code}' "$URL")
echo "HTTP status: $STATUS"

if [[ "$STATUS" != "200" ]]; then
  echo "❌ /command-hub returned HTTP $STATUS"
  exit 1
fi

# Check static HTML shell markers (no JS execution here)
grep -q "Vitana Command Hub" /tmp/ch.html || { echo "❌ Page title marker not found"; exit 1; }
grep -q "task-board" /tmp/ch.html || { echo "❌ .task-board container not found in HTML"; exit 1; }
grep -q "app.js" /tmp/ch.html || { echo "❌ app.js script tag not found"; exit 1; }

echo "✅ Command Hub frontend verified: v0 shell and bundle wiring are correct."
