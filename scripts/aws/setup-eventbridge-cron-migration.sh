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
# VTID-04226 (2026-09-21) — two more jobs, and the Lambda grew three
# optional Input fields to carry them:
#   gateway-test-contracts-scheduled-run  POST /api/v1/test-contracts/scheduled-run
#   gateway-test-contracts-missing        GET  /api/v1/test-contracts/missing
# Both routes lost their scheduler with GCP and were never in this list —
# their source_types (test-contract-failure-scanner / missing-test-scanner,
# autopilot-executable-source-types.ts) are in the executor lane but nothing
# ever produced a row for them. NOTE: no GCP cadence for them exists in git
# (scripts/setup-cloud-scheduler.sh never listed them; the route header said
# "operator wires this manually post-merge"), so the cadences below are
# CHOSEN here, not restored: */15 for the live-probe scanner (its debounce/
# quarantine state machine expects a steady tick), daily for the missing-test
# listing. Both authenticate with `X-Gateway-Internal` — the Lambda reads
# that token from Secrets Manager at invoke time (`auth: "gateway_internal"`
# in the Input, secret id in GATEWAY_INTERNAL_TOKEN_SECRET_ID), never from a
# plain env var or the schedule Input. The secret is provisioned by
# scripts/aws/setup-gateway-internal-token.sh and wired onto the gateway
# task def by AWS-STAGE-DEPLOY-GATEWAY.yml once it exists (VTID-04225).
# Until then the two schedules run and get an honest 403 — loud in the
# Lambda log, not silent. Per-job `gateway_url` lets these two target the
# STAGING gateway (TEST_CONTRACTS_GATEWAY_URL) while the rest keep prod.
# `GET /missing` is a read-only listing — it produces no rows by itself;
# the row-producing sweep is a documented gap, not built here.
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
#   DEFAULT_TENANT_ID=<uuid> ./scripts/aws/setup-eventbridge-cron-migration.sh [--delete] [--dry-run] [--only <name-prefix>]...
#
# --only <name-prefix> (VTID-04352, repeatable) limits the run to the jobs whose
# NAME starts with one of the prefixes. It exists so one group can be switched
# on at a time: e.g. the nightly memory/learning jobs (AP-0906..AP-0913) without
# also creating the member-facing notification schedules in the same pass.
#   DEFAULT_TENANT_ID=<uuid> ./scripts/aws/setup-eventbridge-cron-migration.sh --only autopilot-memory- --dry-run
# With --delete, --only removes only the matching schedules and leaves the
# shared Lambda and both IAM roles alone (other schedules still use them).
# A prefix list that matches nothing is an error, never a silent no-op.
# Note: of the eight memory jobs, AP-0907 (autopilot-memory-daily-learning-digest)
# is member-facing — one "I learned something new about you" push per user at
# their local 18:00, only on days new facts were learned. The other seven write
# memory only. To start the silent seven first, pass each as its own --only:
#   --only autopilot-memory-routine-pattern-extraction
#   --only autopilot-memory-relationship-graph-projection
#   --only autopilot-memory-behavior-preference-inference
#   --only autopilot-memory-health-correlation-insights
#   --only autopilot-memory-user-model-synthesis
#   --only autopilot-memory-own-post-capture
#   --only autopilot-memory-embedding-backfill
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
# VTID-04226: the test-contract scanners target STAGING until the owner
# promotes them (IF-THEN 26); override to gateway.vitanaland.com deliberately.
TEST_CONTRACTS_GATEWAY_URL="${TEST_CONTRACTS_GATEWAY_URL:-https://preview-aws-gateway.vitanaland.com}"
# VTID-04349: the AP-XXXX automation jobs start on the STAGING gateway, where
# AUTOMATIONS_DELIVERY_MODE=shadow records notifications and writes instead of
# performing them. Pointing them at production (live, real members) is the
# owner's go-live decision: re-run with AUTOMATIONS_GATEWAY_URL=https://gateway.vitanaland.com
# once staging shadow runs are verified. /api/v1/automations/* now requires
# X-Gateway-Internal, so these jobs carry auth=gateway_internal.
AUTOMATIONS_GATEWAY_URL="${AUTOMATIONS_GATEWAY_URL:-https://preview-aws-gateway.vitanaland.com}"
INTERNAL_TOKEN_SECRET_ID="${GATEWAY_INTERNAL_TOKEN_SECRET_ID:-vitana/gateway/staging/internal-token}"

LAMBDA_NAME="vitana-cron-dispatch"
LAMBDA_EXEC_ROLE_NAME="vitana-cron-dispatch-lambda-exec"
SCHEDULER_ROLE_NAME="vitana-scheduler-cron-dispatch"

DELETE=false
DRY_RUN=false
ONLY_PREFIXES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete) DELETE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --only)
      if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
        echo "ERROR: --only needs a job-name prefix, e.g. --only autopilot-memory-" >&2; exit 1
      fi
      ONLY_PREFIXES+=("$2"); shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$TENANT_ID" && "$DELETE" = "false" ]]; then
  echo "ERROR: DEFAULT_TENANT_ID required (baked into each AP-XXXX job's Input body at creation time, same as the GCP script it replaces)." >&2
  exit 1
fi

# Format: NAME|SCHEDULE(5-field unix cron)|TIMEZONE|PATH|BODY_JSON[|EXTRA_INPUT_JSON]
# EXTRA_INPUT_JSON (optional, VTID-04226) is merged into the schedule's
# Input: {"method":"GET","auth":"gateway_internal","gateway_url":"https://..."}
# Verbatim from scripts/setup-cloud-scheduler.sh's JOBS + MEMORY_INTELLIGENCE_JOBS
# + DIRECT_JOBS (minus push-dispatch, already migrated) + TENANT_DIRECT_JOBS.
JOBS=(
  "autopilot-daily-match-delivery|0 8 * * *|Europe/Berlin|/api/v1/automations/cron/AP-0101|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-morning-briefing|0 7 * * *|Europe/Berlin|/api/v1/automations/cron/AP-0501|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-diary-reminder|0 21 * * *|Europe/Berlin|/api/v1/automations/cron/AP-0505|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-weekly-community-digest|0 18 * * 0|Europe/Berlin|/api/v1/automations/cron/AP-0502|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-weekly-reflection|0 20 * * 5|Europe/Berlin|/api/v1/automations/cron/AP-0506|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-group-recommendation-push|0 10 * * 1|Europe/Berlin|/api/v1/automations/cron/AP-0105|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-social-alignment|0 9 * * 1|Europe/Berlin|/api/v1/automations/cron/AP-0107|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-creator-digest|0 18 * * 0|Europe/Berlin|/api/v1/automations/cron/AP-0210|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-trending-events|0 18 * * 0|Europe/Berlin|/api/v1/automations/cron/AP-0305|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-wellness-check-in|0 10 * * 3|Europe/Berlin|/api/v1/automations/cron/AP-0604|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-upcoming-events-today|0 8 * * *|Europe/Berlin|/api/v1/automations/cron/AP-0510|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-memory-routine-pattern-extraction|30 3 * * *|UTC|/api/v1/automations/cron/AP-0906|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-memory-relationship-graph-projection|50 3 * * *|UTC|/api/v1/automations/cron/AP-0909|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-memory-behavior-preference-inference|40 4 * * *|UTC|/api/v1/automations/cron/AP-0908|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-memory-health-correlation-insights|55 4 * * *|UTC|/api/v1/automations/cron/AP-0912|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-memory-user-model-synthesis|35 * * * *|UTC|/api/v1/automations/cron/AP-0911|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-memory-own-post-capture|15 * * * *|UTC|/api/v1/automations/cron/AP-0913|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-memory-embedding-backfill|25 * * * *|UTC|/api/v1/automations/cron/AP-0910|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-memory-daily-learning-digest|10 * * * *|UTC|/api/v1/automations/cron/AP-0907|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-memory-daily-learning-episode|45 * * * *|UTC|/api/v1/automations/cron/AP-0914|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "autopilot-memory-diary-theme-rollup|25 4 * * *|UTC|/api/v1/automations/cron/AP-0915|{\"tenant_id\":\"$TENANT_ID\"}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$AUTOMATIONS_GATEWAY_URL\"}"
  "gateway-reminders-tick|* * * * *|UTC|/api/v1/scheduled-notifications/reminders-tick|{}"
  "gateway-reminders-sweeper|*/5 * * * *|UTC|/api/v1/scheduled-notifications/reminders-sweeper|{}"
  "gateway-daily-recompute|0 2 * * *|UTC|/api/v1/scheduler/daily-recompute|{\"tenant_id\":\"$TENANT_ID\"}"
  "gateway-daily-pace-notifications|0 * * * *|UTC|/api/v1/scheduled-notifications/daily-pace-notifications|{\"tenant_id\":\"$TENANT_ID\"}"
  "gateway-daily-feature-tip|0 17 * * *|UTC|/api/v1/scheduled-notifications/daily-feature-tip|{\"tenant_id\":\"$TENANT_ID\"}"
  "gateway-night-push|0 * * * *|UTC|/api/v1/scheduled-notifications/night-push|{\"tenant_id\":\"$TENANT_ID\"}"
  # VTID-04226 — test-contract scanners (see header). Cadence chosen, not restored.
  "gateway-test-contracts-scheduled-run|*/15 * * * *|UTC|/api/v1/test-contracts/scheduled-run|{}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$TEST_CONTRACTS_GATEWAY_URL\"}"
  "gateway-test-contracts-missing|30 6 * * *|UTC|/api/v1/test-contracts/missing|{}|{\"method\":\"GET\",\"auth\":\"gateway_internal\",\"gateway_url\":\"$TEST_CONTRACTS_GATEWAY_URL\"}"
  # VTID-04407 — Operator thread handoffs (developer memory). Staging: that is
  # where OPERATOR_THREADS_ENABLED records threads. Hourly; idempotent.
  "gateway-dev-memory-handoff-sweep|20 * * * *|UTC|/api/v1/dev-memory/handoffs/sweep|{}|{\"auth\":\"gateway_internal\",\"gateway_url\":\"$TEST_CONTRACTS_GATEWAY_URL\"}"
)

# VTID-04352: --only narrows JOBS to the requested name prefixes.
if [[ ${#ONLY_PREFIXES[@]} -gt 0 ]]; then
  SELECTED=()
  for JOB in "${JOBS[@]}"; do
    NAME="${JOB%%|*}"
    for PREFIX in "${ONLY_PREFIXES[@]}"; do
      if [[ "$NAME" == "$PREFIX"* ]]; then SELECTED+=("$JOB"); break; fi
    done
  done
  if [[ ${#SELECTED[@]} -eq 0 ]]; then
    echo "ERROR: --only ${ONLY_PREFIXES[*]} matches none of the ${#JOBS[@]} jobs." >&2
    exit 1
  fi
  JOBS=("${SELECTED[@]}")
fi

echo "Region:   $REGION"
echo "Account:  $ACCOUNT_ID"
echo "Gateway:  $GATEWAY_URL"
echo "Test-contract gateway: $TEST_CONTRACTS_GATEWAY_URL (internal token secret: $INTERNAL_TOKEN_SECRET_ID)"
echo "Jobs:     ${#JOBS[@]}${ONLY_PREFIXES[0]:+  (--only ${ONLY_PREFIXES[*]})}"
echo "Delete:   $DELETE"
echo "Dry run:  $DRY_RUN"
echo ""

if $DELETE; then
  if [[ ${#ONLY_PREFIXES[@]} -gt 0 ]]; then
    echo "Deleting ${#JOBS[@]} matching schedules (shared Lambda and IAM roles kept — other schedules use them)..."
    for JOB in "${JOBS[@]}"; do
      IFS='|' read -r NAME _ _ _ _ <<< "$JOB"
      if $DRY_RUN; then echo "  would delete $NAME"; else aws scheduler delete-schedule --name "$NAME" --region "$REGION" 2>/dev/null || true; fi
    done
    echo "Done."
    exit 0
  fi
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
    IFS='|' read -r NAME SCHEDULE TIMEZONE PATH_ BODY EXTRA <<< "$JOB"
    echo "  $NAME  ($SCHEDULE $TIMEZONE)  -> $PATH_  body=$BODY${EXTRA:+  extra=$EXTRA}"
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
# VTID-04226: read-only access to the ONE internal-token secret (any version
# suffix), so `auth: "gateway_internal"` jobs can fetch it at invoke time.
INTERNAL_TOKEN_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "secretsmanager:GetSecretValue",
    "Resource": "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${INTERNAL_TOKEN_SECRET_ID}-*"
  }]
}
JSON
)
aws iam put-role-policy \
  --role-name "$LAMBDA_EXEC_ROLE_NAME" \
  --policy-name "read-gateway-internal-token" \
  --policy-document "$INTERNAL_TOKEN_POLICY"

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
// VTID-04226 — optional Input fields: `method` (default POST), `gateway_url`
// (per-job target override, e.g. staging for the test-contract scanners),
// `headers` (extra plain headers), and `auth: "gateway_internal"` which adds
// `X-Gateway-Internal: <token>` read from Secrets Manager
// (GATEWAY_INTERNAL_TOKEN_SECRET_ID) and cached for the container lifetime.
// The token never sits in the schedule Input or a plain env var.
let cachedInternalToken = null;
async function internalToken() {
  if (cachedInternalToken) return cachedInternalToken;
  const secretId = process.env.GATEWAY_INTERNAL_TOKEN_SECRET_ID;
  if (!secretId) throw new Error('auth=gateway_internal requested but GATEWAY_INTERNAL_TOKEN_SECRET_ID is unset');
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
  const raw = out.SecretString || '';
  let token = raw;
  try { const parsed = JSON.parse(raw); if (parsed && typeof parsed.token === 'string') token = parsed.token; } catch (_) { /* plain string secret */ }
  if (!token) throw new Error(`secret ${secretId} is empty — run scripts/aws/setup-gateway-internal-token.sh`);
  cachedInternalToken = token;
  return token;
}

exports.handler = async (event) => {
  const path = event && event.path;
  const method = (event && event.method ? String(event.method) : 'POST').toUpperCase();
  const body = method === 'GET' ? '' : (event && typeof event.body === 'string' ? event.body : JSON.stringify(event && event.body || {}));
  if (!path) throw new Error('Lambda invoked with no `path` in its Input — check the schedule Target.Input');

  const headers = Object.assign({}, (event && event.headers) || {});
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  if (event && event.auth === 'gateway_internal') headers['X-Gateway-Internal'] = await internalToken();

  const base = (event && event.gateway_url) || process.env.GATEWAY_URL || 'https://gateway.vitanaland.com';
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method,
        headers,
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
    if (body) req.write(body);
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
  --environment "Variables={GATEWAY_URL=$GATEWAY_URL,GATEWAY_INTERNAL_TOKEN_SECRET_ID=$INTERNAL_TOKEN_SECRET_ID}" \
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
    --environment "Variables={GATEWAY_URL=$GATEWAY_URL,GATEWAY_INTERNAL_TOKEN_SECRET_ID=$INTERNAL_TOKEN_SECRET_ID}"
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
  IFS='|' read -r NAME SCHEDULE TIMEZONE PATH_ BODY EXTRA <<< "$JOB"
  EXTRA="${EXTRA:-{\}}"
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
  'Input': json.dumps(dict({'path': '$PATH_', 'body': json.loads('$BODY')}, **json.loads('$EXTRA')))
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
