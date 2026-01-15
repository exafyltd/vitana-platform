#!/bin/bash
set -e

echo "=================================================="
echo "Phase 1.5 Verification (No Lies Edition)"
echo "VTID: DEV-COMMU-0042.G | Updated: VTID-01176"
echo "=================================================="
echo ""

# VTID-01176: Use canonical gateway URL (vitana-dev-gateway is deprecated redirector)
GATEWAY_URL="${GATEWAY_URL:-https://vitana-gateway-86804897789.us-central1.run.app}"
FAILURES=0

# Test 1: Command Hub UI
echo "Test 1: Command Hub UI..."
if curl -sf "$GATEWAY_URL/command-hub" | grep -q "Command HUB"; then
    echo "✅ PASS"
else
    echo "❌ FAIL"
    FAILURES=$((FAILURES + 1))
fi

# Test 2: Events endpoint (must have data)
echo "Test 2: OASIS Events (must be non-empty)..."
EVENT_COUNT=$(curl -s "$GATEWAY_URL/events" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [ "$EVENT_COUNT" -gt 0 ]; then
    echo "✅ PASS ($EVENT_COUNT events)"
else
    echo "❌ FAIL (empty events)"
    FAILURES=$((FAILURES + 1))
fi

# Test 3: AutoLogger health
echo "Test 3: AutoLogger Health..."
AL_STATUS=$(curl -s "$GATEWAY_URL/health/auto-logger" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "error")
if [ "$AL_STATUS" = "ok" ]; then
    echo "✅ PASS"
else
    echo "❌ FAIL"
    FAILURES=$((FAILURES + 1))
fi

# Test 4: Google Chat integration
echo "Test 4: Google Chat Test Message..."
RESPONSE=$(curl -s -X POST "$GATEWAY_URL/events/ingest" \
  -H "Content-Type: application/json" \
  -d '{"service":"verify","event":"test","tenant":"vitana","status":"success","notes":"Verification test","metadata":{"vtid":"DEV-COMMU-0042.G"}}')
if echo "$RESPONSE" | grep -q '"ok":true'; then
    echo "✅ PASS (check Google Chat for message)"
else
    echo "❌ FAIL"
    FAILURES=$((FAILURES + 1))
fi

# Test 5: Chat API (no rate limits)
echo "Test 5: Chat API (10 requests)..."
SUCCESS=0
for i in {1..10}; do
    HTTP_CODE=$(curl -s -w "%{http_code}" -o /dev/null -X POST "$GATEWAY_URL/command-hub/api/chat" \
        -H "Content-Type: application/json" -d '{"message":"test"}')
    [ "$HTTP_CODE" = "200" ] && SUCCESS=$((SUCCESS + 1))
    sleep 0.3
done
if [ "$SUCCESS" -ge 9 ]; then
    echo "✅ PASS ($SUCCESS/10)"
else
    echo "❌ FAIL ($SUCCESS/10)"
    FAILURES=$((FAILURES + 1))
fi

echo ""
echo "=================================================="
if [ "$FAILURES" -eq 0 ]; then
    echo "🎉 ALL TESTS PASSED"
    echo "Phase A & B: COMPLETE"
    exit 0
else
    echo "❌ $FAILURES TESTS FAILED"
    exit 1
fi
