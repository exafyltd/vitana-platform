#!/usr/bin/env bash
set -euo pipefail

# Configuration
GATEWAY_URL="${GATEWAY_URL:-https://vitana-gateway-86804897789.us-central1.run.app}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-}"
TENANT="${TENANT:-system}"

# Parse arguments
EVENT_TYPE="${1:-unknown}"
SERVICE_NAME="${2:-unknown}"
STATUS="${3:-success}"
NOTES="${4:-}"
RID="${5:-$(openssl rand -hex 4)}"

if [ "$EVENT_TYPE" = "unknown" ] || [ "$SERVICE_NAME" = "unknown" ]; then
  echo "❌ Usage: $0 <event_type> <service_name> <status> [notes] [rid]"
  exit 1
fi

PAYLOAD=$(cat <<EOF
{
  "service": "$SERVICE_NAME",
  "event": "$EVENT_TYPE",
  "tenant": "$TENANT",
  "data": {
    "rid": "$RID",
    "status": "$STATUS",
    "notes": "$NOTES",
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "git_sha": "$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
  }
}
EOF
)

echo "📡 Reporting: $SERVICE_NAME/$EVENT_TYPE ($STATUS)"

curl -fsS -X POST "$GATEWAY_URL/new-request-with-notification" \
  -H "Content-Type: application/json" \
  ${GATEWAY_TOKEN:+-H "Authorization: Bearer $GATEWAY_TOKEN"} \
  -d "$PAYLOAD" 2>&1 || {
  echo "⚠️  Gateway report failed (non-blocking)"
  exit 0
}

echo "✅ Report sent (RID: $RID)"
