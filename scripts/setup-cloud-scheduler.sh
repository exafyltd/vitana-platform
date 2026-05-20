#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Cloud Scheduler Jobs for Autopilot CRON Automations
# VTID: VTID-01250
#
# Creates gcloud scheduler jobs that POST to the gateway
# /api/v1/automations/cron/<AP-ID> endpoint.
#
# Usage:
#   ./scripts/setup-cloud-scheduler.sh [--delete] [--dry-run]
#
# Prerequisites:
#   - gcloud CLI authenticated
#   - Cloud Scheduler API enabled
#   - DEFAULT_TENANT_ID env var set (or passed via --tenant)
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ────────────────────────────────────────────────────
PROJECT="${GCP_PROJECT_ID:-lovable-vitana-vers1}"
REGION="${GCP_REGION:-us-central1}"
GATEWAY_URL="${GATEWAY_URL:-https://vitana-gateway-q74ibpv6ia-uc.a.run.app}"
TENANT_ID="${DEFAULT_TENANT_ID:-}"
DELETE=false
DRY_RUN=false

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete) DELETE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --tenant) TENANT_ID="$2"; shift 2 ;;
    --gateway) GATEWAY_URL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$TENANT_ID" ]]; then
  echo "ERROR: DEFAULT_TENANT_ID or --tenant required"
  exit 1
fi

echo "Project:  $PROJECT"
echo "Region:   $REGION"
echo "Gateway:  $GATEWAY_URL"
echo "Tenant:   ${TENANT_ID:0:8}…"
echo "Delete:   $DELETE"
echo "Dry run:  $DRY_RUN"
echo ""

# ── Job Definitions ───────────────────────────────────────────
# Format: AP_ID|NAME|SCHEDULE|TIMEZONE
JOBS=(
  "AP-0101|daily-match-delivery|0 8 * * *|Europe/Berlin"
  "AP-0501|morning-briefing|0 7 * * *|Europe/Berlin"
  "AP-0505|diary-reminder|0 21 * * *|Europe/Berlin"
  "AP-0502|weekly-community-digest|0 18 * * 0|Europe/Berlin"
  "AP-0506|weekly-reflection|0 20 * * 5|Europe/Berlin"
  "AP-0105|group-recommendation-push|0 10 * * 1|Europe/Berlin"
  "AP-0107|social-alignment|0 9 * * 1|Europe/Berlin"
  "AP-0210|creator-digest|0 18 * * 0|Europe/Berlin"
  "AP-0305|trending-events|0 18 * * 0|Europe/Berlin"
  "AP-0604|wellness-check-in|0 10 * * 3|Europe/Berlin"
  "AP-0510|upcoming-events-today|0 8 * * *|Europe/Berlin"
)

for JOB in "${JOBS[@]}"; do
  IFS='|' read -r AP_ID NAME SCHEDULE TIMEZONE <<< "$JOB"
  JOB_NAME="autopilot-${NAME}"
  TARGET_URL="${GATEWAY_URL}/api/v1/automations/cron/${AP_ID}"

  if $DELETE; then
    echo "Deleting: $JOB_NAME"
    if ! $DRY_RUN; then
      gcloud scheduler jobs delete "$JOB_NAME" \
        --project="$PROJECT" \
        --location="$REGION" \
        --quiet 2>/dev/null || echo "  (not found, skipping)"
    fi
  else
    echo "Creating: $JOB_NAME → $AP_ID ($SCHEDULE $TIMEZONE)"
    if ! $DRY_RUN; then
      # Delete first if exists (upsert pattern)
      gcloud scheduler jobs delete "$JOB_NAME" \
        --project="$PROJECT" \
        --location="$REGION" \
        --quiet 2>/dev/null || true

      gcloud scheduler jobs create http "$JOB_NAME" \
        --project="$PROJECT" \
        --location="$REGION" \
        --schedule="$SCHEDULE" \
        --time-zone="$TIMEZONE" \
        --uri="$TARGET_URL" \
        --http-method=POST \
        --headers="Content-Type=application/json" \
        --message-body="{\"tenant_id\":\"$TENANT_ID\"}" \
        --attempt-deadline=300s \
        --max-retry-attempts=1 \
        --description="Autopilot $AP_ID: $NAME"
    fi
  fi
done

echo ""
echo "Done. ${#JOBS[@]} scheduler jobs processed."
