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
# API destination — no compute (no Lambda) needed.
#
# SCOPE: this covers ONLY gateway-push-dispatch. scripts/setup-cloud-
# scheduler.sh still defines ~25 other GCP Cloud Scheduler jobs (the
# AP-XXXX automation registry jobs, the memory-intelligence jobs, the
# tenant-scoped daily jobs) that are EQUALLY BROKEN by the same missing
# GCP billing account — those need the identical AWS migration but are
# deliberately NOT done here.
#
# VERIFIED against a live AWS account 2026-08-18 (account 472838866351)
# after two real bugs found and fixed on the first run:
#   1. AWS_REGION collision: AWS CloudShell auto-exports AWS_REGION to
#      match whichever region tab is open, which silently overrode this
#      script's eu-central-1 default (everything got created in
#      us-east-1 on the first attempt). Deliberately reads
#      VITANA_AWS_REGION instead, which nothing else sets, so this
#      script's own default always wins unless explicitly overridden.
#   2. Connection/API-destination ARNs are now resolved from AWS's own
#      create/describe JSON responses, not hand-constructed — a
#      hand-built ARN with a trailing "/*" (valid in an IAM policy
#      Resource field, invalid as a literal create-api-destination
#      parameter) failed AWS's own ARN regex validation on the first run.
#   3. Scheduler's Target schema has NO HttpParameters field (that
#      belongs to EventBridge RULES, a different/older API surface,
#      not EventBridge SCHEDULER) — confirmed via a real
#      ParamValidation error naming the actual allowed fields. Removed;
#      the route needs no particular header to function.
#
# Usage:
#   ./scripts/aws/setup-eventbridge-push-dispatch.sh [--delete] [--dry-run]
#
# Prerequisites:
#   - aws CLI v2 + jq, authenticated (`aws sts get-caller-identity` should work)
#   - IAM permissions: iam:CreateRole, iam:PutRolePolicy, iam:GetRole,
#     events:CreateConnection, events:DescribeConnection,
#     events:CreateApiDestination, events:DescribeApiDestination,
#     scheduler:CreateSchedule, scheduler:UpdateSchedule, scheduler:GetSchedule
#     (+ Delete* for --delete)
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ────────────────────────────────────────────────────
# Deliberately VITANA_AWS_REGION, not AWS_REGION — see header note above.
REGION="${VITANA_AWS_REGION:-eu-central-1}"           # matches the rest of this repo's AWS estate (CLAUDE.md §2b)
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

if $DELETE; then
  echo "Deleting schedule, API destination, connection, and IAM role..."
  aws scheduler delete-schedule --name "$SCHEDULE_NAME" --region "$REGION" 2>/dev/null || true
  aws events delete-api-destination --name "$API_DEST_NAME" --region "$REGION" 2>/dev/null || true
  aws events delete-connection --name "$CONNECTION_NAME" --region "$REGION" 2>/dev/null || true
  aws iam delete-role-policy --role-name "$SCHEDULER_ROLE_NAME" --policy-name "invoke-api-destination" 2>/dev/null || true
  aws iam delete-role --role-name "$SCHEDULER_ROLE_NAME" 2>/dev/null || true
  echo "Done."
  exit 0
fi

if $DRY_RUN; then
  echo "Dry run — would create/update a connection, API destination, IAM role, and schedule in $REGION. Exiting without making changes."
  exit 0
fi

# ── 1. EventBridge Connection ────────────────────────────────
# API destinations require a Connection with SOME auth mechanism — there
# is no "no auth" option. The gateway route does not check for this
# header (matching the GCP Cloud Scheduler job it replaces, which was
# also unauthenticated); it exists only because EventBridge requires a
# Connection to have an authorization type.
echo "── Creating EventBridge connection: $CONNECTION_NAME"
if CONN_JSON=$(aws events create-connection \
  --name "$CONNECTION_NAME" \
  --region "$REGION" \
  --authorization-type API_KEY \
  --auth-parameters '{"ApiKeyAuthParameters":{"ApiKeyName":"X-Scheduler-Trigger","ApiKeyValue":"vitana-push-dispatch"}}' 2>&1); then
  echo "$CONN_JSON"
else
  echo "  (create failed — checking whether it already exists)"
  CONN_JSON=$(aws events describe-connection --name "$CONNECTION_NAME" --region "$REGION")
fi
CONNECTION_ARN=$(echo "$CONN_JSON" | jq -r '.ConnectionArn')
echo "Connection ARN: $CONNECTION_ARN"

# ── 2. EventBridge API destination ───────────────────────────
echo "── Creating API destination: $API_DEST_NAME"
if DEST_JSON=$(aws events create-api-destination \
  --name "$API_DEST_NAME" \
  --region "$REGION" \
  --connection-arn "$CONNECTION_ARN" \
  --invocation-endpoint "${GATEWAY_URL}${TARGET_PATH}" \
  --http-method POST \
  --invocation-rate-limit-per-second 1 2>&1); then
  echo "$DEST_JSON"
else
  echo "  (create failed — checking whether it already exists)"
  DEST_JSON=$(aws events describe-api-destination --name "$API_DEST_NAME" --region "$REGION")
fi
API_DEST_ARN=$(echo "$DEST_JSON" | jq -r '.ApiDestinationArn')
echo "API destination ARN: $API_DEST_ARN"

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
aws iam create-role \
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
aws iam put-role-policy \
  --role-name "$SCHEDULER_ROLE_NAME" \
  --policy-name "invoke-api-destination" \
  --policy-document "$INVOKE_POLICY"

SCHEDULER_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${SCHEDULER_ROLE_NAME}"

echo "Waiting 10s for IAM role propagation..."
sleep 10

# ── 4. EventBridge Scheduler schedule (every minute — matching the
#      old GCP job; 1 minute is also Scheduler's floor for rate()) ──
# NOTE: Scheduler's Target schema has no HttpParameters field — that
# belongs to EventBridge RULES (a different API), not SCHEDULER.
# Confirmed via a real ParamValidation error on the first run against
# this exact CLI. The route needs no particular header to function, so
# it's simply omitted rather than guessed at again.
echo "── Creating/updating schedule: $SCHEDULE_NAME"
TARGET=$(cat <<JSON
{
  "Arn": "${API_DEST_ARN}",
  "RoleArn": "${SCHEDULER_ROLE_ARN}",
  "Input": "{}",
  "RetryPolicy": { "MaximumRetryAttempts": 1 }
}
JSON
)
if aws scheduler create-schedule \
  --name "$SCHEDULE_NAME" \
  --region "$REGION" \
  --schedule-expression "rate(1 minute)" \
  --flexible-time-window '{"Mode":"OFF"}' \
  --state ENABLED \
  --target "$TARGET"; then
  echo "Schedule created."
else
  echo "  (create failed — trying update-schedule instead, in case it already exists)"
  aws scheduler update-schedule \
    --name "$SCHEDULE_NAME" \
    --region "$REGION" \
    --schedule-expression "rate(1 minute)" \
    --flexible-time-window '{"Mode":"OFF"}' \
    --state ENABLED \
    --target "$TARGET"
  echo "Schedule updated."
fi

echo ""
echo "Done. Verify with:"
echo "  aws scheduler get-schedule --name $SCHEDULE_NAME --region $REGION --query 'State'"
echo ""
echo "Then confirm it's actually firing — the push notification backlog"
echo "in user_notifications should start draining within a few minutes."
