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
# SCOPE: this covers ONLY gateway-push-dispatch. scripts/setup-cloud-
# scheduler.sh still defines ~25 other GCP Cloud Scheduler jobs that
# are EQUALLY BROKEN by the same missing GCP billing account — those
# need the identical AWS migration but are deliberately NOT done here.
#
# ARCHITECTURE, and why it changed mid-build (both found via REAL
# ValidationExceptions against a live account, 472838866351,
# eu-central-1, 2026-08-18):
#
#   Attempt 1: EventBridge Scheduler → EventBridge API destination
#   directly (Target.Arn = the api-destination ARN). This is a common
#   assumption (Rules and Pipes both support API destinations as
#   targets) but Scheduler does NOT: `aws scheduler create-schedule`
#   rejected a syntactically-correct, freshly-minted api-destination
#   ARN with "Provided Arn is not in correct format" — not a typo, a
#   genuine unsupported-target-type rejection. If you're tempted to
#   "fix" this by targeting an API destination again, don't — it's
#   been tried and confirmed unsupported.
#
#   Attempt 2 (this version): EventBridge Scheduler → Lambda → the
#   Lambda does the actual HTTPS POST to the gateway. Lambda-as-
#   Scheduler-target is a first-class, unambiguous, well-documented
#   integration — no format guessing involved. The EventBridge
#   connection + API destination created by attempt 1 are orphaned by
#   this pivot (harmless, zero ongoing cost) — clean up manually if
#   you like:
#     aws events delete-api-destination --name vitana-push-dispatch --region eu-central-1
#     aws events delete-connection --name vitana-push-dispatch-trigger --region eu-central-1
#
# Usage:
#   ./scripts/aws/setup-eventbridge-push-dispatch.sh [--delete] [--dry-run]
#
# Prerequisites:
#   - aws CLI v2 + jq + zip, authenticated (`aws sts get-caller-identity`)
#   - IAM permissions: iam:CreateRole, iam:PutRolePolicy, iam:DeleteRolePolicy,
#     iam:AttachRolePolicy, iam:GetRole, lambda:CreateFunction,
#     lambda:UpdateFunctionCode, lambda:GetFunction,
#     scheduler:CreateSchedule, scheduler:UpdateSchedule, scheduler:GetSchedule
#     (+ Delete* for --delete)
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ────────────────────────────────────────────────────
# Deliberately VITANA_AWS_REGION, not AWS_REGION — AWS CloudShell auto-
# exports AWS_REGION to match whichever region tab is open, which
# silently overrode this script's eu-central-1 default on an earlier
# run (everything got created in us-east-1 instead).
REGION="${VITANA_AWS_REGION:-eu-central-1}"           # matches the rest of this repo's AWS estate (CLAUDE.md §2b)
ACCOUNT_ID="${AWS_ACCOUNT_ID:-472838866351}"          # this repo's documented AWS account (CLAUDE.md §1b)
GATEWAY_URL="${GATEWAY_URL:-https://gateway.vitanaland.com}"
TARGET_PATH="/api/v1/scheduled-notifications/push-dispatch"

LAMBDA_NAME="vitana-push-dispatch"
LAMBDA_EXEC_ROLE_NAME="vitana-push-dispatch-lambda-exec"
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
  echo "Deleting schedule, Lambda function, and IAM roles..."
  aws scheduler delete-schedule --name "$SCHEDULE_NAME" --region "$REGION" 2>/dev/null || true
  aws lambda delete-function --function-name "$LAMBDA_NAME" --region "$REGION" 2>/dev/null || true
  aws iam delete-role-policy --role-name "$SCHEDULER_ROLE_NAME" --policy-name "invoke-lambda-target" 2>/dev/null || true
  aws iam delete-role-policy --role-name "$SCHEDULER_ROLE_NAME" --policy-name "invoke-api-destination" 2>/dev/null || true
  aws iam delete-role --role-name "$SCHEDULER_ROLE_NAME" 2>/dev/null || true
  aws iam detach-role-policy --role-name "$LAMBDA_EXEC_ROLE_NAME" --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" 2>/dev/null || true
  aws iam delete-role --role-name "$LAMBDA_EXEC_ROLE_NAME" 2>/dev/null || true
  echo "Done. (Any orphaned EventBridge connection/API destination from an earlier attempt are unaffected — see script header for their cleanup commands.)"
  exit 0
fi

if $DRY_RUN; then
  echo "Dry run — would create/update a Lambda function, two IAM roles, and a schedule in $REGION. Exiting."
  exit 0
fi

# ── 1. Lambda execution role ─────────────────────────────────
echo "── Creating Lambda execution role: $LAMBDA_EXEC_ROLE_NAME"
LAMBDA_TRUST_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
JSON
)
aws iam create-role \
  --role-name "$LAMBDA_EXEC_ROLE_NAME" \
  --assume-role-policy-document "$LAMBDA_TRUST_POLICY" \
  --description "Execution role for vitana-push-dispatch Lambda (VTID-03676)" \
  || echo "  (role may already exist — continuing)"
aws iam attach-role-policy \
  --role-name "$LAMBDA_EXEC_ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
LAMBDA_EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${LAMBDA_EXEC_ROLE_NAME}"

echo "Waiting 10s for IAM role propagation..."
sleep 10

# ── 2. Lambda function code ──────────────────────────────────
echo "── Packaging Lambda function"
WORKDIR=$(mktemp -d)
cat > "$WORKDIR/index.js" <<'JS'
const https = require('https');

// VTID-03676: fires the same unauthenticated POST GCP Cloud Scheduler
// used to send. The route needs no request body or special headers.
exports.handler = async () => {
  const url = new URL(
    (process.env.GATEWAY_URL || 'https://gateway.vitanaland.com') +
    '/api/v1/scheduled-notifications/push-dispatch'
  );
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 0 },
        timeout: 25000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          console.log(`push-dispatch responded ${res.statusCode}: ${body.slice(0, 500)}`);
          resolve({ statusCode: res.statusCode, body });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('push-dispatch request timed out')));
    req.on('error', reject);
    req.end();
  });
};
JS
(cd "$WORKDIR" && zip -q function.zip index.js)

echo "── Creating/updating Lambda function: $LAMBDA_NAME"
if aws lambda create-function \
  --function-name "$LAMBDA_NAME" \
  --region "$REGION" \
  --runtime nodejs20.x \
  --role "$LAMBDA_EXEC_ROLE_ARN" \
  --handler index.handler \
  --zip-file "fileb://$WORKDIR/function.zip" \
  --timeout 30 \
  --environment "Variables={GATEWAY_URL=$GATEWAY_URL}" \
  --description "Vitana push-dispatch cron trigger (VTID-03676) — replaces the GCP Cloud Scheduler job of the same purpose" 2>&1; then
  echo "Function created."
else
  echo "  (create failed — trying update-function-code instead, in case it already exists)"
  aws lambda update-function-code \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --zip-file "fileb://$WORKDIR/function.zip"
  echo "Function code updated."
fi
LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}"
rm -rf "$WORKDIR"

# ── 3. IAM role EventBridge Scheduler assumes to invoke the Lambda ──
echo "── Creating Scheduler invoke role: $SCHEDULER_ROLE_NAME"
SCHEDULER_TRUST_POLICY=$(cat <<JSON
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
  --assume-role-policy-document "$SCHEDULER_TRUST_POLICY" \
  --description "Allows EventBridge Scheduler to invoke the push-dispatch Lambda (VTID-03676)" \
  || echo "  (role may already exist — continuing)"

# Clean up the stale events:InvokeApiDestination policy from the earlier
# (unsupported) attempt, if it's still attached.
aws iam delete-role-policy --role-name "$SCHEDULER_ROLE_NAME" --policy-name "invoke-api-destination" 2>/dev/null || true

INVOKE_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "lambda:InvokeFunction",
    "Resource": "${LAMBDA_ARN}"
  }]
}
JSON
)
aws iam put-role-policy \
  --role-name "$SCHEDULER_ROLE_NAME" \
  --policy-name "invoke-lambda-target" \
  --policy-document "$INVOKE_POLICY"

SCHEDULER_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${SCHEDULER_ROLE_NAME}"

echo "Waiting 10s for IAM role propagation..."
sleep 10

# ── 4. EventBridge Scheduler schedule (every minute — matching the
#      old GCP job; 1 minute is also Scheduler's floor for rate()) ──
echo "── Creating/updating schedule: $SCHEDULE_NAME"
TARGET=$(cat <<JSON
{
  "Arn": "${LAMBDA_ARN}",
  "RoleArn": "${SCHEDULER_ROLE_ARN}",
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
  echo "  (create failed — trying update-schedule instead)"
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
echo "  aws logs tail /aws/lambda/$LAMBDA_NAME --region $REGION --since 5m   # confirm it's actually being invoked and succeeding"
echo ""
echo "Then confirm the push notification backlog in user_notifications"
echo "starts draining within a few minutes."
