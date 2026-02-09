#!/bin/bash
# Production verification script for intelligence/memory stack
GW="https://gateway-q74ibpv6ia-uc.a.run.app"
TID="00000000-0000-0000-0000-000000000001"
UID_="00000000-0000-0000-0000-000000000099"
THID="00000000-0000-0000-0000-aaaaaaaaa001"

echo "=== 1. Health Check ==="
curl -s "$GW/health" | python3 -m json.tool
echo ""

echo "=== 2. Write: favorite color is blue ==="
curl -s -X POST "$GW/api/v1/conversation/turn" \
  -H "Content-Type: application/json" \
  -d "{
    \"channel\": \"orb\",
    \"tenant_id\": \"$TID\",
    \"user_id\": \"$UID_\",
    \"thread_id\": \"$THID\",
    \"message\": {\"type\": \"text\", \"text\": \"My favorite color is blue and I live in Amsterdam\"}
  }" | python3 -m json.tool
echo ""

echo "=== 3. Recall: what is my favorite color? ==="
curl -s -X POST "$GW/api/v1/conversation/turn" \
  -H "Content-Type: application/json" \
  -d "{
    \"channel\": \"orb\",
    \"tenant_id\": \"$TID\",
    \"user_id\": \"$UID_\",
    \"thread_id\": \"$THID\",
    \"message\": {\"type\": \"text\", \"text\": \"What is my favorite color and where do I live?\"}
  }" | python3 -m json.tool
echo ""

echo "=== 4. Cross-session recall (new thread) ==="
curl -s -X POST "$GW/api/v1/conversation/turn" \
  -H "Content-Type: application/json" \
  -d "{
    \"channel\": \"orb\",
    \"tenant_id\": \"$TID\",
    \"user_id\": \"$UID_\",
    \"thread_id\": \"00000000-0000-0000-0000-aaaaaaaaa002\",
    \"message\": {\"type\": \"text\", \"text\": \"What is my favorite color?\"}
  }" | python3 -m json.tool
echo ""

echo "=== Done ==="
