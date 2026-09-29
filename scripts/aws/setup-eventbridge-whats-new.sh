#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# AWS EventBridge Scheduler → Lambda → gateway: daily What's New card
# VTID: VTID-04733
#
# Fires POST /api/v1/scheduled-notifications/whats-new once a day at 16:00 UTC.
# The gateway reads the PRODUCTION frontend's /whats-new.json and publishes at
# most one new "Brand New Feature" News Feed card (+ push) per run — see the
# route's header comment in scheduled-notifications.ts. Same AWS-native shape
# as setup-eventbridge-daily-feature-tip.sh (VTID-04733) — no GCP dependency.
#
# Kill switch without touching AWS: set WHATS_NEW_AUTOPUBLISH=false on the
# gateway. Idempotent to re-run (create-or-update).
#
# Usage:
#   ./scripts/aws/setup-eventbridge-whats-new.sh [--delete] [--dry-run]
#
# Prerequisites: aws CLI v2 + jq + zip, authenticated; same IAM permissions as
# setup-eventbridge-daily-feature-tip.sh.
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# AWS CLI v2 pipes JSON output through `less` by default whenever stdout is a
# TTY (e.g. CloudShell) — every `aws ... create-*`/`describe-*` call below
# then silently blocks the script waiting for a keypress to advance the
# pager, which looks exactly like a hang. Disable it for this script only.
export AWS_PAGER=""

# ── Config ────────────────────────────────────────────────────
# Deliberately VITANA_AWS_REGION, not AWS_REGION — AWS CloudShell auto-
# exports AWS_REGION to match whichever region tab is open, which bit
# the push-dispatch migration this script mirrors (everything got
# created in us-east-1 on an earlier run).
REGION="${VITANA_AWS_REGION:-eu-central-1}"           # matches the rest of this repo's AWS estate (CLAUDE.md §2b)
ACCOUNT_ID="${AWS_ACCOUNT_ID:-472838866351}"          # this repo's documented AWS account (CLAUDE.md §1b)
GATEWAY_URL="${GATEWAY_URL:-https://gateway.vitanaland.com}"
TARGET_PATH="/api/v1/scheduled-notifications/whats-new"
# Same tenant the earlier direct-DB test/publish rounds this session used.
TENANT_ID="${DEFAULT_TENANT_ID:-2e7528b8-472a-4356-88da-0280d4639cce}"

LAMBDA_NAME="vitana-whats-new"
LAMBDA_EXEC_ROLE_NAME="vitana-whats-new-lambda-exec"
SCHEDULE_NAME="gateway-whats-new"
SCHEDULER_ROLE_NAME="vitana-scheduler-whats-new"

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
echo "Tenant:       $TENANT_ID"
echo "Delete:       $DELETE"
echo "Dry run:      $DRY_RUN"
echo ""

if $DELETE; then
  echo "Deleting schedule, Lambda function, and IAM roles..."
  aws scheduler delete-schedule --name "$SCHEDULE_NAME" --region "$REGION" 2>/dev/null || true
  aws lambda delete-function --function-name "$LAMBDA_NAME" --region "$REGION" 2>/dev/null || true
  aws iam delete-role-policy --role-name "$SCHEDULER_ROLE_NAME" --policy-name "invoke-lambda-target" 2>/dev/null || true
  aws iam delete-role --role-name "$SCHEDULER_ROLE_NAME" 2>/dev/null || true
  aws iam detach-role-policy --role-name "$LAMBDA_EXEC_ROLE_NAME" --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" 2>/dev/null || true
  aws iam delete-role --role-name "$LAMBDA_EXEC_ROLE_NAME" 2>/dev/null || true
  echo "Done."
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
  --description "Execution role for vitana-whats-new Lambda (VTID-04733)" \
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

// No scheduler-level retry (see the schedule's RetryPolicy below). The
// gateway dedupes by entry id and enforces a 20h gap, so a retry would be
// harmless, but a failed run (manifest unreachable, DB down) publishes
// nothing and simply tries again at the next daily tick — one clean failure
// in CloudWatch Logs beats hammering a struggling dependency.
exports.handler = async () => {
  const url = new URL(
    (process.env.GATEWAY_URL || 'https://gateway.vitanaland.com') +
    '/api/v1/scheduled-notifications/whats-new'
  );
  const payload = JSON.stringify({ tenant_id: process.env.TENANT_ID });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 55000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          console.log(`whats-new responded ${res.statusCode}: ${body.slice(0, 500)}`);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body });
          } else {
            reject(new Error(`whats-new returned ${res.statusCode}: ${body.slice(0, 500)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('whats-new request timed out')));
    req.on('error', reject);
    req.write(payload);
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
  --timeout 60 \
  --environment "Variables={GATEWAY_URL=$GATEWAY_URL,TENANT_ID=$TENANT_ID}" \
  --description "Vitana whats-new cron trigger (VTID-04733)" 2>&1; then
  echo "Function created."
else
  echo "  (create failed — updating code AND config instead, in case it already exists)"
  aws lambda update-function-code \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --zip-file "fileb://$WORKDIR/function.zip"
  aws lambda wait function-updated --function-name "$LAMBDA_NAME" --region "$REGION"
  aws lambda update-function-configuration \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --timeout 60 \
    --environment "Variables={GATEWAY_URL=$GATEWAY_URL,TENANT_ID=$TENANT_ID}"
  echo "Function code and configuration updated."
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
  --description "Allows EventBridge Scheduler to invoke the whats-new Lambda (VTID-04733)" \
  || echo "  (role may already exist — continuing)"

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

# ── 4. EventBridge Scheduler schedule — daily at 16:00 UTC (an hour
#      before the Did-You-Know tip). AWS cron() needs 6 fields; day-of-
#      month and day-of-week can't both be a value, so day-of-month is
#      "*" and day-of-week is "?" for an every-day schedule. ──
echo "── Creating/updating schedule: $SCHEDULE_NAME"
TARGET=$(cat <<JSON
{
  "Arn": "${LAMBDA_ARN}",
  "RoleArn": "${SCHEDULER_ROLE_ARN}",
  "RetryPolicy": { "MaximumRetryAttempts": 0 }
}
JSON
)
if aws scheduler create-schedule \
  --name "$SCHEDULE_NAME" \
  --region "$REGION" \
  --schedule-expression "cron(0 16 * * ? *)" \
  --schedule-expression-timezone "UTC" \
  --flexible-time-window '{"Mode":"OFF"}' \
  --state ENABLED \
  --target "$TARGET"; then
  echo "Schedule created."
else
  echo "  (create failed — trying update-schedule instead)"
  aws scheduler update-schedule \
    --name "$SCHEDULE_NAME" \
    --region "$REGION" \
    --schedule-expression "cron(0 16 * * ? *)" \
    --schedule-expression-timezone "UTC" \
    --flexible-time-window '{"Mode":"OFF"}' \
    --state ENABLED \
    --target "$TARGET"
  echo "Schedule updated."
fi

echo ""
echo "Done. Verify with:"
echo "  aws scheduler get-schedule --name $SCHEDULE_NAME --region $REGION --query 'State'"
echo "  aws logs tail /aws/lambda/$LAMBDA_NAME --region $REGION --since 5m   # after it fires at 16:00 UTC"
