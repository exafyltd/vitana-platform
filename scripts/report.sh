#!/usr/bin/env bash
set -euo pipefail

# Configuration
GATEWAY_URL="${GATEWAY_URL:-https://vitana-gateway-86804897789.us-central1.run.app}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-}"
TENANT="${TENANT:-system}"
USE_PERSIST="${USE_PERSIST:-1}"

# Parse arguments
EVENT_TYPE="${1:-unknown}"
SERVICE_NAME="${2:-unknown}"
STATUS="${3:-success}"
NOTES="${4:-}"
RID="${5:-$(command -v uuidgen >/dev/null && uuidgen || openssl rand -hex 4)}"

if [ "$EVENT_TYPE" = "unknown" ] || [ "$SERVICE_NAME" = "unknown" ]; then
  echo "❌ Usage: $0 <event_type> <service_name> <status> [notes] [rid]"
  exit 1
fi

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "📡 Reporting: $SERVICE_NAME/$EVENT_TYPE ($STATUS) [RID: $RID]"

# Legacy payload
LEGACY_PAYLOAD=$(cat <<LEGACY
{
  "service": "$SERVICE_NAME",
  "event": "$EVENT_TYPE",
  "tenant": "$TENANT",
  "data": {
    "rid": "$RID",
    "status": "$STATUS",
    "notes": "$NOTES",
    "timestamp": "$TIMESTAMP",
    "git_sha": "$GIT_SHA"
  }
}
LEGACY
)

# OASIS payload
PERSIST_PAYLOAD=$(cat <<PERSIST
{
  "service": "$SERVICE_NAME",
  "event": "$EVENT_TYPE",
  "tenant": "$TENANT",
  "status": "$STATUS",
  "notes": "$NOTES",
  "git_sha": "$GIT_SHA",
  "rid": "$RID",
  "timestamp": "$TIMESTAMP"
}
PERSIST
)

# Send to legacy
curl -fsS -X POST "$GATEWAY_URL/new-request-with-notification" \
  -H "Content-Type: application/json" \
  ${GATEWAY_TOKEN:+-H "Authorization: Bearer $GATEWAY_TOKEN"} \
  -d "$LEGACY_PAYLOAD" 2>&1 >/dev/null || {
  echo "⚠️  Legacy notification failed (non-blocking)"
}

# Send to persistence
if [ "$USE_PERSIST" -eq 1 ]; then
  if curl -fsS -X POST "$GATEWAY_URL/events/ingest" \
    -H "Content-Type: application/json" \
    ${GATEWAY_TOKEN:+-H "Authorization: Bearer $GATEWAY_TOKEN"} \
    -d "$PERSIST_PAYLOAD" 2>&1 >/dev/null; then
    echo "✅ Event persisted: $RID"
  else
    echo "⚠️  Persistence failed (non-blocking)"
  fi
else
  echo "ℹ️  Persistence disabled (USE_PERSIST=0)"
fi

echo "✅ Report complete"
