#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# AWS EventBridge Scheduler replacement for the GCP Cloud Scheduler
# job "gateway-push-dispatch"
# VTID: VTID-03676 (follows VTID-03656)
#
# WHY THIS EXISTS: VTID-03656 fixed /push-dispatch's own logic (a
# stalled scheduler no longer permanently orphans notifications) and
# registered the job in scripts/setup-cloud-scheduler.sh — but that
# script needs `gcloud scheduler jobs create`, and the GCP project
# `lovable-vitana-vers1` has NO LINKED BILLING ACCOUNT (confirmed
# 2026-08-18 via the GCP Console: "This project has no billing
# account"). Cloud Scheduler's create API requires active billing, so
# that fix cannot actually be deployed on GCP. Direction from the
# platform owner: move this — and eventually everything else this
# repo runs on GCP Cloud Scheduler — onto AWS.
#
# This script is the AWS-native equivalent for ONE job: it recreates
# what GCP Cloud Scheduler did (fire an unauthenticated HTTP POST to
# the gateway once a minute) using EventBridge Scheduler + an EventBridge
# API destination — no compute (no Lambda) needed, matching the
# original's "just an HTTP POST caller" shape as closely as AWS allows.
#
# SCOPE: this covers ONLY gateway-push-dispatch. scripts/setup-cloud-
# scheduler.sh still defines ~25 other GCP Cloud Scheduler jobs (the
# AP-XXXX automation registry jobs, the memory-intelligence jobs, the
# tenant-scoped daily jobs) that are EQUALLY BROKEN by the same missing
# GCP billing account — those need the identical AWS migration but are
# deliberately NOT done here. Do not assume they still work.
#
# ⚠️ NOT YET VERIFIED AGAINST LIVE AWS. This session has no AWS CLI
# credentials to run and confirm these commands. Run this from AWS
# CloudShell or a machine with `aws` configured against an account
# with permission to create IAM roles/policies, EventBridge
# connections/API destinations, and EventBridge Scheduler schedules.
# If any command errors, the error message + `aws --version` output is
# enough for a follow-up fix — the JSON shapes below follow documented
# AWS CLI syntax but haven't been round-tripped against a real account.
#
# Usage:
#   AWS_ACCOUNT_ID=<id> ./scripts/aws/setup-eventbridge-push-dispatch.sh [--delete] [--dry-run]
#
# Prerequisites:
#   - aws CLI v2, authenticated (`aws sts get-caller-identity` should work)
#   - IAM permissions: iam:CreateRole, iam:PutRolePolicy, iam:GetRole,
#     events:CreateConnection, events:CreateApiDestination,
#     scheduler:CreateSchedule, scheduler:GetSchedule (+ Delete* for --delete)
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ────────────────────────────────────────────────────
REGION="${AWS_REGION:-eu-central-1}"                 # matches the rest of this repo's AWS estate (CLAUDE.md §2b)
ACCOUNT_ID="${AWS_ACCOUNT_ID:-472838866351}"          # this repo's documented AWS account (CLAUDE.md §1b)
GATEWAY_URL="${GATEWAY_URL:-https://gateway.vitanaland.com}"
TARGET_PATH="/api/v1/scheduled-notifications/push-dispatch"

CONNECTION_NAME="vitana-push-dispatch-trigger"
API_DEST_NAME="vitana-push-dispatch"
SCHEDULE_NAME="gateway-push-dispatch"
SCHEDULER_ROLE_NAME="vitana-scheduler-push-dispatch"

DELETE=false
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete) DELETE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "Region:       $REGION"
echo "Account:      $ACCOUNT_ID"
echo "Gateway:      $GATEWAY_URL$TARGET_PATH"
echo "Delete:       $DELETE"
echo "Dry run:      $DRY_RUN"
echo ""

run() {
  echo "+ $*"
  if ! $DRY_RUN; then "$@"; fi
}

if $DELETE; then
  echo "Deleting schedule, API destination, connection, and IAM role..."
  run aws scheduler delete-schedule --name "$SCHEDULE_NAME" --region "$REGION" 2>/dev/null || true
  run aws events delete-api-destination --name "$API_DEST_NAME" --region "$REGION" 2>/dev/null || true
  run aws events delete-connection --name "$CONNECTION_NAME" --region "$REGION" 2>/dev/null || true
  run aws iam delete-role-policy --role-name "$SCHEDULER_ROLE_NAME" --policy-name "invoke-api-destination" 2>/dev/null || true
  run aws iam delete-role --role-name "$SCHEDULER_ROLE_NAME" 2>/dev/null || true
  echo "Done."
  exit 0
fi

# ── 1. EventBridge Connection ────────────────────────────────
# API destinations require a Connection with SOME auth mechanism — there
# is no "no auth" option. The gateway route itself does not check for
# this header (matching the GCP Cloud Scheduler job it replaces, which
# was also unauthenticated); it exists only because EventBridge requires
# a Connection to have an authorization type.
echo "── Creating EventBridge connection: $CONNECTION_NAME"
run aws events create-connection \
  --name "$CONNECTION_NAME" \
  --region "$REGION" \
  --authorization-type API_KEY \
  --auth-parameters '{"ApiKeyAuthParameters":{"ApiKeyName":"X-Scheduler-Trigger","ApiKeyValue":"vitana-push-dispatch"}}' \
  || echo "  (connection may already exist — continuing)"

CONNECTION_ARN="arn:aws:events:${REGION}:${ACCOUNT_ID}:connection/${CONNECTION_NAME}/*"

# ── 2. EventBridge API destination ───────────────────────────
echo "── Creating API destination: $API_DEST_NAME"
run aws events create-api-destination \
  --name "$API_DEST_NAME" \
  --region "$REGION" \
  --connection-arn "$CONNECTION_ARN" \
  --invocation-endpoint "${GATEWAY_URL}${TARGET_PATH}" \
  --http-method POST \
  --invocation-rate-limit-per-second 1 \
  || echo "  (API destination may already exist — continuing)"

API_DEST_ARN="arn:aws:events:${REGION}:${ACCOUNT_ID}:api-destination/${API_DEST_NAME}/*"

# ── 3. IAM role EventBridge Scheduler assumes to invoke it ──
echo "── Creating IAM role: $SCHEDULER_ROLE_NAME"
TRUST_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "scheduler.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" } }
  }]
}
JSON
)
run aws iam create-role \
  --role-name "$SCHEDULER_ROLE_NAME" \
  --assume-role-policy-document "$TRUST_POLICY" \
  --description "Allows EventBridge Scheduler to invoke the push-dispatch API destination (VTID-03676)" \
  || echo "  (role may already exist — continuing)"

INVOKE_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "events:InvokeApiDestination",
    "Resource": "${API_DEST_ARN}"
  }]
}
JSON
)
run aws iam put-role-policy \
  --role-name "$SCHEDULER_ROLE_NAME" \
  --policy-name "invoke-api-destination" \
  --policy-document "$INVOKE_POLICY"

SCHEDULER_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${SCHEDULER_ROLE_NAME}"

# IAM role propagation can lag a few seconds behind create-role.
if ! $DRY_RUN; then
  echo "Waiting 10s for IAM role propagation..."
  sleep 10
fi

# ── 4. EventBridge Scheduler schedule (every minute, matching the
#      old GCP job — 1 minute is also EventBridge Scheduler's floor
#      for a rate() expression) ───────────────────────────────
echo "── Creating schedule: $SCHEDULE_NAME"
TARGET=$(cat <<JSON
{
  "Arn": "arn:aws:events:${REGION}:${ACCOUNT_ID}:api-destination/${API_DEST_NAME}/*",
  "RoleArn": "${SCHEDULER_ROLE_ARN}",
  "HttpParameters": { "HeaderParameters": { "Content-Type": "application/json" } },
  "Input": "{}",
  "RetryPolicy": { "MaximumRetryAttempts": 1 }
}
JSON
)
run aws scheduler create-schedule \
  --name "$SCHEDULE_NAME" \
  --region "$REGION" \
  --schedule-expression "rate(1 minute)" \
  --flexible-time-window '{"Mode":"OFF"}' \
  --state ENABLED \
  --target "$TARGET" \
  || echo "  (schedule may already exist — try --delete first, or use update-schedule)"

echo ""
echo "Done. Verify with:"
echo "  aws scheduler get-schedule --name $SCHEDULE_NAME --region $REGION --query 'State'"
echo "  aws scheduler list-schedules --region $REGION --query \"Schedules[?Name=='$SCHEDULE_NAME']\""
echo ""
echo "Then confirm it's actually firing — re-run the read-only backlog query"
echo "against user_notifications a few minutes later (see PR description)."
