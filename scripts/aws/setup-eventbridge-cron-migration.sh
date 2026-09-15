#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# AWS EventBridge Scheduler replacement for the remaining ~25 GCP
# Cloud Scheduler jobs in scripts/setup-cloud-scheduler.sh.
# VTID-03766 (follows VTID-03656/VTID-03676)
#
# WHY THIS EXISTS
#
# VTID-03676 built the Scheduler→Lambda pattern for exactly one job
# (gateway-push-dispatch, scripts/aws/setup-eventbridge-push-dispatch.sh)
# after confirming live that EventBridge Scheduler cannot target an API
# destination directly (a real ValidationException, not a guess). That
# script's own header flagged the other ~25 GCP Cloud Scheduler jobs in
# scripts/setup-cloud-scheduler.sh as "EQUALLY BROKEN by the same missing
# GCP billing account... deliberately NOT done here." This is that
# follow-up.
#
# DESIGN: ONE shared Lambda, not 25 near-identical ones. Every job here
# is the same shape — POST a fixed JSON body to a fixed gateway path on a
# schedule — so one Lambda reads `path` and `body` from the EventBridge
# Scheduler Input payload at invoke time instead of each job getting its
# own deployed function. 25 schedules, 1 function, 2 IAM roles total.
#
# WHAT THIS DOES NOT DO
#
# It does not touch gateway-push-dispatch — that already has its own
# working Lambda+schedule from VTID-03676, left alone. It does not
# delete the GCP scheduler job DEFINITIONS in scripts/setup-cloud-
# scheduler.sh (that file stays as the historical record of what ran on
# GCP); this is a parallel AWS-native replacement, not an edit to that
# file's job list, which is still what GCP itself is un-runnable against
# (no billing account, VTID-03656/03676's own finding).
#
# Usage:
#   DEFAULT_TENANT_ID=<uuid> ./scripts/aws/setup-eventbridge-cron-migration.sh [--delete] [--dry-run]
#
# Prerequisites (NOT covered by this session's AWS grant as of VTID-03766
# — see docs/AURORA-B6-STORAGE-INVENTORY.md's sibling B7 finding for why
# iam:PassRole/new-role-creation was deliberately left out of that ask):
#   - iam:CreateRole, iam:PutRolePolicy, iam:AttachRolePolicy, iam:GetRole
#   - lambda:CreateFunction, lambda:UpdateFunctionCode,
#     lambda:UpdateFunctionConfiguration, lambda:GetFunction
#   - scheduler:CreateSchedule, scheduler:UpdateSchedule, scheduler:GetSchedule
#     (+ Delete* for --delete)
# ──────────────────────────────────────────────────────────────

set -euo pipefail

REGION="${VITANA_AWS_REGION:-eu-central-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-472838866351}"
GATEWAY_URL="${GATEWAY_URL:-https://gateway.vitanaland.com}"
TENANT_ID="${DEFAULT_TENANT_ID:-}"

LAMBDA_NAME="vitana-cron-dispatch"
LAMBDA_EXEC_ROLE_NAME="vitana-cron-dispatch-lambda-exec"
SCHEDULER_ROLE_NAME="vitana-scheduler-cron-dispatch"

DELETE=false
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete) DELETE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$TENANT_ID" && "$DELETE" = "false" ]]; then
  echo "ERROR: DEFAULT_TENANT_ID required (baked into each AP-XXXX job's Input body at creation time, same as the GCP script it replaces)." >&2
  exit 1
fi

# Format: NAME|SCHEDULE(5-field unix cron)|TIMEZONE|PATH|BODY_JSON
# Verbatim from scripts/setup-cloud-scheduler.sh's JOBS + MEMORY_INTELLIGENCE_JOBS
# + DIRECT_JOBS (minus push-dispatch, already migrated) + TENANT_DIRECT_JOBS.
JOBS=(
  "autopilot-daily-match-delivery|0 8 * * *|Europe/Berlin|/api/v1/automations/cron/AP-0101|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-morning-briefing|0 7 * * *|Europe/Berlin|/api/v1/automations/cron/AP-0501|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-diary-reminder|0 21 * * *|Europe/Berlin|/api/v1/automations/cron/AP-0505|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-weekly-community-digest|0 18 * * 0|Europe/Berlin|/api/v1/automations/cron/AP-0502|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-weekly-reflection|0 20 * * 5|Europe/Berlin|/api/v1/automations/cron/AP-0506|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-group-recommendation-push|0 10 * * 1|Europe/Berlin|/api/v1/automations/cron/AP-0105|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-social-alignment|0 9 * * 1|Europe/Berlin|/api/v1/automations/cron/AP-0107|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-creator-digest|0 18 * * 0|Europe/Berlin|/api/v1/automations/cron/AP-0210|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-trending-events|0 18 * * 0|Europe/Berlin|/api/v1/automations/cron/AP-0305|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-wellness-check-in|0 10 * * 3|Europe/Berlin|/api/v1/automations/cron/AP-0604|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-upcoming-events-today|0 8 * * *|Europe/Berlin|/api/v1/automations/cron/AP-0510|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-memory-routine-pattern-extraction|30 3 * * *|UTC|/api/v1/automations/cron/AP-0906|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-memory-relationship-graph-projection|50 3 * * *|UTC|/api/v1/automations/cron/AP-0909|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-memory-behavior-preference-inference|40 4 * * *|UTC|/api/v1/automations/cron/AP-0908|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-memory-health-correlation-insights|55 4 * * *|UTC|/api/v1/automations/cron/AP-0912|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-memory-user-model-synthesis|35 * * * *|UTC|/api/v1/automations/cron/AP-0911|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-memory-own-post-capture|15 * * * *|UTC|/api/v1/automations/cron/AP-0913|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-memory-embedding-backfill|25 * * * *|UTC|/api/v1/automations/cron/AP-0910|{\"tenant_id\":\"$TENANT_ID\"}"
  "autopilot-memory-daily-learning-digest|10 * * * *|UTC|/api/v1/automations/cron/AP-0907|{\"tenant_id\":\"$TENANT_ID\"}"
  "gateway-reminders-tick|* * * * *|UTC|/api/v1/scheduled-notifications/reminders-tick|{}"
  "gateway-reminders-sweeper|*/5 * * * *|UTC|/api/v1/scheduled-notifications/reminders-sweeper|{}"
  "gateway-daily-recompute|0 2 * * *|UTC|/api/v1/scheduler/daily-recompute|{\"tenant_id\":\"$TENANT_ID\"}"
  "gateway-daily-pace-notifications|0 * * * *|UTC|/api/v1/scheduled-notifications/daily-pace-notifications|{\"tenant_id\":\"$TENANT_ID\"}"
  "gateway-daily-feature-tip|0 17 * * *|UTC|/api/v1/scheduled-notifications/daily-feature-tip|{\"tenant_id\":\"$TENANT_ID\"}"
  "gateway-night-push|0 * * * *|UTC|/api/v1/scheduled-notifications/night-push|{\"tenant_id\":\"$TENANT_ID\"}"
)

echo "Region:   $REGION"
echo "Account:  $ACCOUNT_ID"
echo "Gateway:  $GATEWAY_URL"
echo "Jobs:     ${#JOBS[@]}"
echo "Delete:   $DELETE"
echo "Dry run:  $DRY_RUN"
echo ""

if $DELETE; then
  echo "Deleting all ${#JOBS[@]} schedules, the shared Lambda, and both IAM roles..."
  for JOB in "${JOBS[@]}"; do
    IFS='|' read -r NAME _ _ _ _ <<< "$JOB"
    aws scheduler delete-schedule --name "$NAME" --region "$REGION" 2>/dev/null || true
  done
  aws lambda delete-function --function-name "$LAMBDA_NAME" --region "$REGION" 2>/dev/null || true
  aws iam delete-role-policy --role-name "$SCHEDULER_ROLE_NAME" --policy-name "invoke-lambda-target" 2>/dev/null || true
  aws iam delete-role --role-name "$SCHEDULER_ROLE_NAME" 2>/dev/null || true
  aws iam detach-role-policy --role-name "$LAMBDA_EXEC_ROLE_NAME" --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" 2>/dev/null || true
  aws iam delete-role --role-name "$LAMBDA_EXEC_ROLE_NAME" 2>/dev/null || true
  echo "Done."
  exit 0
fi

if $DRY_RUN; then
  echo "Would create/update 1 Lambda, 2 IAM roles, and ${#JOBS[@]} schedules:"
  for JOB in "${JOBS[@]}"; do
    IFS='|' read -r NAME SCHEDULE TIMEZONE PATH_ BODY <<< "$JOB"
    echo "  $NAME  ($SCHEDULE $TIMEZONE)  -> $PATH_  body=$BODY"
  done
  exit 0
fi

# ── 1. Lambda execution role (shared by all 25 jobs) ─────────
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
  --description "Execution role for the shared vitana-cron-dispatch Lambda (VTID-03766)" \
  || echo "  (role may already exist — continuing)"
aws iam attach-role-policy \
  --role-name "$LAMBDA_EXEC_ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
LAMBDA_EXEC_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${LAMBDA_EXEC_ROLE_NAME}"

echo "Waiting 10s for IAM role propagation..."
sleep 10

# ── 2. The shared Lambda — reads path+body from the Scheduler Input ──
echo "── Packaging shared cron-dispatch Lambda"
WORKDIR=$(mktemp -d)
cat > "$WORKDIR/index.js" <<'JS'
const https = require('https');

// VTID-03766 — one Lambda serves every migrated cron job. Each
// EventBridge Scheduler target supplies its own `path` and `body` via
// the schedule's Input JSON, so this function is pure plumbing: POST
// `body` to GATEWAY_URL + path, fail loudly on non-2xx (mirrors the
// push-dispatch Lambda's own P2 review fix — a 500 must surface as a
// Lambda failure, not a silent success, or nothing can ever alert on
// it). 170s timeout matches the longest-running known job
// (AP-XXXX automations, same headroom push-dispatch uses).
exports.handler = async (event) => {
  const path = event && event.path;
  const body = event && typeof event.body === 'string' ? event.body : JSON.stringify(event && event.body || {});
  if (!path) throw new Error('Lambda invoked with no `path` in its Input — check the schedule Target.Input');

  const url = new URL((process.env.GATEWAY_URL || 'https://gateway.vitanaland.com') + path);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 170000,
      },
      (res) => {
        let respBody = '';
        res.on('data', (chunk) => { respBody += chunk; });
        res.on('end', () => {
          console.log(`${path} responded ${res.statusCode}: ${respBody.slice(0, 500)}`);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: respBody });
          } else {
            reject(new Error(`${path} returned ${res.statusCode}: ${respBody.slice(0, 500)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${path} request timed out`)));
    req.on('error', reject);
    req.write(body);
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
  --timeout 180 \
  --environment "Variables={GATEWAY_URL=$GATEWAY_URL}" \
  --description "Shared cron-dispatch trigger for the remaining ~25 migrated GCP Cloud Scheduler jobs (VTID-03766)" 2>&1; then
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
    --timeout 180 \
    --environment "Variables={GATEWAY_URL=$GATEWAY_URL}"
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
  --description "Allows EventBridge Scheduler to invoke the shared cron-dispatch Lambda (VTID-03766)" \
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

# ── 4. One EventBridge Scheduler schedule per job ────────────
# 5-field unix cron -> EventBridge's 6-field cron(minute hour day-of-month
# month day-of-week year), trailing wildcard year appended.
to_eventbridge_cron() {
  echo "cron($1 *)"
}

CREATED=0
FAILED=0
for JOB in "${JOBS[@]}"; do
  IFS='|' read -r NAME SCHEDULE TIMEZONE PATH_ BODY <<< "$JOB"
  EB_CRON=$(to_eventbridge_cron "$SCHEDULE")
  # Built in Python, not a bash heredoc — the Input field is itself a
  # JSON-encoded string (EventBridge Scheduler's contract), and getting
  # that double-encoding right with bash quoting alone is fragile.
  TARGET=$(python3 -c "
import json, sys
print(json.dumps({
  'Arn': '$LAMBDA_ARN',
  'RoleArn': '$SCHEDULER_ROLE_ARN',
  'RetryPolicy': {'MaximumRetryAttempts': 1},
  'Input': json.dumps({'path': '$PATH_', 'body': json.loads('$BODY')})
}))
")

  echo "── $NAME  ($EB_CRON $TIMEZONE) -> $PATH_"
  if aws scheduler create-schedule \
    --name "$NAME" \
    --region "$REGION" \
    --schedule-expression "$EB_CRON" \
    --schedule-expression-timezone "$TIMEZONE" \
    --flexible-time-window '{"Mode":"OFF"}' \
    --state ENABLED \
    --target "$TARGET" > /dev/null 2>&1; then
    echo "  created."
    CREATED=$((CREATED+1))
  else
    if aws scheduler update-schedule \
      --name "$NAME" \
      --region "$REGION" \
      --schedule-expression "$EB_CRON" \
      --schedule-expression-timezone "$TIMEZONE" \
      --flexible-time-window '{"Mode":"OFF"}' \
      --state ENABLED \
      --target "$TARGET" > /dev/null 2>&1; then
      echo "  updated (already existed)."
      CREATED=$((CREATED+1))
    else
      echo "  FAILED — see above for the error."
      FAILED=$((FAILED+1))
    fi
  fi
done

echo ""
echo "Done. $CREATED/${#JOBS[@]} schedules created/updated, $FAILED failed."
echo ""
echo "Verify with:"
echo "  aws scheduler list-schedules --region $REGION --query 'Schedules[].Name'"
echo "  aws logs tail /aws/lambda/$LAMBDA_NAME --region $REGION --since 10m"
