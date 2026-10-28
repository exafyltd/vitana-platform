#!/usr/bin/env bash
# VTID-05103 — report a failed scheduled check into the one self-healing intake.
#
# Usage (from a workflow step with `if: failure()`):
#   scripts/ci/report-to-self-healing.sh <check-name> <endpoint> <summary>
#
#   check-name  the workflow's check, e.g. alert-push-dispatch-health
#   endpoint    the ops route or synthetic id the check is about; self-healing
#               dedups on it (e.g. /api/v1/ops/health/push-dispatch, or
#               alert-workflow://ALERT-PUSH-DISPATCH-HEALTH)
#   summary     one line: what failed
#
# Env: GATEWAY_URL (default https://preview-aws-gateway.vitanaland.com),
#      SERVICE_TOKEN (the GATEWAY_SERVICE_TOKEN secret), GITHUB_* (run link).
#
# Same request E2E-ORB-MONITOR.yml already sends: POST /api/v1/self-healing/report
# with one "down" service. Reporting never fails the step — the check's own
# failure is the signal, this only makes sure the intake hears about it.

set -u

NAME="${1:?check name required}"
ENDPOINT="${2:?endpoint required}"
SUMMARY="${3:?summary required}"
GATEWAY_URL="${GATEWAY_URL:-https://preview-aws-gateway.vitanaland.com}"

if [ -z "${SERVICE_TOKEN:-}" ]; then
  echo "::warning::GATEWAY_SERVICE_TOKEN not set — self-healing report skipped"
  exit 0
fi

RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"

BODY=$(jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg name "$NAME" \
  --arg endpoint "$ENDPOINT" \
  --arg summary "$SUMMARY" \
  --arg run "$RUN_URL" \
  '{
    timestamp: $ts,
    total: 1,
    live: 0,
    services: [{
      name: $name,
      endpoint: $endpoint,
      status: "down",
      http_status: 0,
      response_body: ($summary + " — run: " + $run),
      response_time_ms: 0,
      error_message: $summary
    }]
  }')

curl -sS -X POST "$GATEWAY_URL/api/v1/self-healing/report" \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  || echo "::warning::Self-healing report POST failed (non-fatal)"

exit 0
