#!/usr/bin/env bash
#
# VTID-04226 — provision the gateway's X-Gateway-Internal token as an AWS
# Secrets Manager secret (vitana/gateway/<env>/internal-token).
#
# WHY THIS EXISTS
#
# routes/test-contracts-scheduled.ts (POST /api/v1/test-contracts/scheduled-run)
# and routes/test-contracts-missing.ts (GET /api/v1/test-contracts/missing)
# accept a machine caller ONLY via `X-Gateway-Internal: <GATEWAY_INTERNAL_TOKEN>`
# — and both isInternalCaller() implementations refuse when the env var is
# unset. Read off the live task definitions on 2026-09-21: NEITHER gateway
# task def (vitana-gateway rev 489, vitana-gateway-awsdr rev 114) carries
# GATEWAY_INTERNAL_TOKEN, and no Secrets Manager entry for it exists. So the
# EventBridge schedules scripts/aws/setup-eventbridge-cron-migration.sh now
# creates for those two routes can only ever get a 403 until this runs.
#
# No Claude Code session has `secretsmanager:CreateSecret` (same constraint
# as setup-fish-audio-secret.sh / setup-erp-bridge-staging.sh) — this is the
# exact, idempotent call an operator runs instead.
#
# WHAT HAPPENS AFTER IT RUNS
#
#   1. AWS-STAGE-DEPLOY-GATEWAY.yml (VTID-04225) resolves
#      vitana/gateway/staging/internal-token OPTIONALLY (ERP-bridge pattern)
#      and, when present, wires it as the GATEWAY_INTERNAL_TOKEN secret on
#      the next staging deploy. Absent => not wired, deploy never fails.
#   2. The shared vitana-cron-dispatch Lambda reads the same secret at invoke
#      time for every job whose Input carries `auth: "gateway_internal"`
#      (its exec role gets secretsmanager:GetSecretValue on exactly this
#      secret from setup-eventbridge-cron-migration.sh).
#   Prod (--env prod) is deliberately NOT wired by any workflow yet — the
#   prod task def change is the owner's promotion decision (IF-THEN 26).
#
# Usage:
#   scripts/aws/setup-gateway-internal-token.sh            # dry-run, staging
#   scripts/aws/setup-gateway-internal-token.sh --apply    # create/rotate, staging
#   scripts/aws/setup-gateway-internal-token.sh --env prod --apply
#
set -euo pipefail

REGION="${VITANA_AWS_REGION:-eu-central-1}"
ENV_NAME="staging"
APPLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true; shift ;;
    --env) ENV_NAME="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done
case "$ENV_NAME" in staging|prod) ;; *) echo "--env must be staging or prod" >&2; exit 1 ;; esac

SECRET_ID="vitana/gateway/${ENV_NAME}/internal-token"
echo "Region:  $REGION"
echo "Secret:  $SECRET_ID"
echo "Apply:   $APPLY"

# The token is a plain string, 64 hex chars — the gateway compares it with
# a constant-string equality (no structure needed). The Lambda also accepts
# a JSON {"token": "..."} secret string, so either shape works.
TOKEN="$(openssl rand -hex 32)"

if ! $APPLY; then
  echo "DRY RUN — would run:"
  echo "  aws secretsmanager create-secret --region $REGION --name $SECRET_ID --description 'Gateway X-Gateway-Internal token (VTID-04226)' --secret-string <64-hex-token>"
  echo "  (or, if it already exists) aws secretsmanager put-secret-value --secret-id $SECRET_ID --secret-string <64-hex-token>"
  echo "Then: redeploy the ${ENV_NAME} gateway (AWS-STAGE-DEPLOY-GATEWAY.yml picks the secret up automatically on staging)."
  exit 0
fi

if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_ID" >/dev/null 2>&1; then
  echo "Secret exists — rotating value (put-secret-value)"
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_ID" --secret-string "$TOKEN" >/dev/null
else
  echo "Creating secret"
  aws secretsmanager create-secret --region "$REGION" --name "$SECRET_ID" \
    --description "Gateway X-Gateway-Internal token for cron/internal callers (VTID-04226)" \
    --secret-string "$TOKEN" >/dev/null
fi
echo "Done. ARN: $(aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_ID" --query ARN --output text)"
echo "Next: redeploy the ${ENV_NAME} gateway so GATEWAY_INTERNAL_TOKEN lands on the task def; the vitana-cron-dispatch Lambda reads the new value on its next cold start."
