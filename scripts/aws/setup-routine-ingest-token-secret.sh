#!/usr/bin/env bash
#
# VTID-04276 — provision the ROUTINE_INGEST_TOKEN secret for the gateway's
# Routine ingest/audit endpoints (services/gateway/src/routes/routines.ts,
# routine-audits.ts).
#
# WHY THIS EXISTS
#
# Every Claude Code Remote Routine that reports run status or reads the
# daily-audit endpoints authenticates with a static `X-Routine-Token`
# header, checked in requireRoutineToken() against process.env.
# ROUTINE_INGEST_TOKEN. That env var is NOT configured on either live AWS
# gateway task definition today — confirmed live via a real 503
# {"error":"ROUTINE_INGEST_TOKEN env var not configured"} response from
# both gateway.vitanaland.com and preview-aws-gateway.vitanaland.com. That
# is why essentially every Routine that calls these endpoints fails (or, on
# the 13 routines whose scripts silently `exit 0` on an empty response,
# falsely reports SUCCEEDED).
#
# No Claude Code session in this repo has `secretsmanager:CreateSecret`
# (CLAUDE.md's own established pattern — see setup-fish-audio-secret.sh /
# setup-erp-bridge-staging.sh's headers). This script is the exact,
# idempotent call an operator runs instead, matching the
# `vitana/gateway/<env>/<key-name>` naming convention every other API-key
# secret here already uses.
#
# WHAT IT DOES NOT DO
#
#   - It does NOT wire the secret into any ECS task definition. That is
#     done separately in AWS-STAGE-DEPLOY-GATEWAY.yml /
#     AWS-PROD-DEPLOY-GATEWAY.yml's optional describe-secret-gated jq
#     block (same pattern as OPERATOR_SQL_READONLY_DATABASE_URL /
#     OPERATOR_MACHINE_AUTH_TOKEN) — absent secret, deploy is unaffected;
#     present secret, it's wired as an ECS `secrets` reference (never a
#     plain env value). Run this script with `--apply` FIRST, confirm the
#     secret exists, THEN let the next deploy pick it up.
#   - It never touches production by default. Pass `--env staging`
#     (default) or `--env prod` explicitly; nothing here defaults to prod.
#
# USAGE
#
#   scripts/aws/setup-routine-ingest-token-secret.sh --env staging               # dry run
#   ROUTINE_INGEST_TOKEN_VALUE=$(openssl rand -hex 32) \
#       scripts/aws/setup-routine-ingest-token-secret.sh --env staging --apply
#   scripts/aws/setup-routine-ingest-token-secret.sh --env staging status

set -euo pipefail

REGION="eu-central-1"
ENV_NAME="staging"
ACTION=""
APPLY=0

say() { echo "[setup-routine-ingest-token-secret] $*"; }
plan() { echo "  [dry-run] $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    provision|status) ACTION="$1"; shift ;;
    --env) ENV_NAME="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ACTION" ]]; then
  echo "Usage: $0 {provision|status} [--env staging|prod] [--apply]" >&2
  exit 1
fi

if [[ "$ENV_NAME" != "staging" && "$ENV_NAME" != "prod" ]]; then
  echo "Refusing unknown --env '$ENV_NAME' — must be 'staging' or 'prod'." >&2
  exit 1
fi

SECRET_NAME="vitana/gateway/${ENV_NAME}/routine-ingest-token"

case "$ACTION" in
  status)
    say "Checking $SECRET_NAME in $REGION ..."
    if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
      say "EXISTS: $SECRET_NAME"
    else
      say "MISSING: $SECRET_NAME"
    fi
    ;;
  provision)
    say "Target secret: $SECRET_NAME (region $REGION)"
    if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
      say "$SECRET_NAME already exists — this script never overwrites a live token. Use the AWS Console/CLI to rotate it."
      exit 0
    fi

    if [[ "$APPLY" != "1" ]]; then
      plan "create secret $SECRET_NAME (value from \$ROUTINE_INGEST_TOKEN_VALUE)"
      say "Dry run only. Re-run with ROUTINE_INGEST_TOKEN_VALUE=\$(openssl rand -hex 32) ... --apply to actually create it."
      exit 0
    fi

    if [[ -z "${ROUTINE_INGEST_TOKEN_VALUE:-}" ]]; then
      echo "ROUTINE_INGEST_TOKEN_VALUE must be set in the environment for --apply (e.g. \$(openssl rand -hex 32))." >&2
      exit 1
    fi

    aws secretsmanager create-secret \
      --region "$REGION" \
      --name "$SECRET_NAME" \
      --description "VTID-04276 Routine ingest token ($ENV_NAME) — shared secret for Claude Code Remote Routine calls to /api/v1/routines/* and /api/v1/routines/audits/*" \
      --secret-string "$ROUTINE_INGEST_TOKEN_VALUE" \
      --tags Key=vtid,Value=VTID-04276 >/dev/null
    say "Created $SECRET_NAME."
    say "Next: confirm AWS-STAGE-DEPLOY-GATEWAY.yml / AWS-PROD-DEPLOY-GATEWAY.yml wire it (this PR adds that), dispatch a deploy, then update each Claude Code Remote Routine's script to send the same token value in X-Routine-Token."
    ;;
esac
