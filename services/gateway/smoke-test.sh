#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL="https://vitana-dev-gateway-86804897789.us-central1.run.app"

echo "🧪 Running Command Hub Smoke Tests"
echo "==================================="
echo "Target: $GATEWAY_URL"
echo ""

echo "1️⃣ Testing Command Hub UI..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/command-hub")
if [ "$HTTP_CODE" = "200" ]; then
  echo "   ✅ Command Hub UI loads (200 OK)"
else
  echo "   ❌ Failed (HTTP $HTTP_CODE)"
fi

echo "2️⃣ Testing health endpoint..."
HEALTH=$(curl -s "$GATEWAY_URL/health")
if echo "$HEALTH" | grep -q "ok"; then
  echo "   ✅ Health check passed"
else
  echo "   ❌ Health check failed"
fi

echo "3️⃣ Testing Command Hub health..."
CMD_HEALTH=$(curl -s "$GATEWAY_URL/command-hub/health")
if echo "$CMD_HEALTH" | grep -q "healthy"; then
  echo "   ✅ Command Hub health check passed"
else
  echo "   ❌ Command Hub health check failed"
fi

echo "4️⃣ Testing VTID list..."
VTID_LIST=$(curl -s "$GATEWAY_URL/vtid/list?limit=5")
if echo "$VTID_LIST" | grep -q '\['; then
  echo "   ✅ VTID list returns data"
else
  echo "   ❌ VTID list failed"
fi

echo "5️⃣ Testing events endpoint..."
EVENTS=$(curl -s "$GATEWAY_URL/events?limit=5")
if echo "$EVENTS" | grep -q '\['; then
  echo "   ✅ Events endpoint returns data"
else
  echo "   ❌ Events endpoint failed"
fi

echo "6️⃣ Testing chat endpoint..."
CHAT_RESPONSE=$(curl -s -X POST "$GATEWAY_URL/command-hub/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"/status"}')
if echo "$CHAT_RESPONSE" | grep -q "response"; then
  echo "   ✅ Chat endpoint works"
else
  echo "   ❌ Chat endpoint failed"
fi

echo ""
echo "✅ All smoke tests complete"
echo ""
echo "🌐 Open Command Hub:"
echo "   $GATEWAY_URL/command-hub"
