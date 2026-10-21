#!/usr/bin/env bash
#
# VTID-03970 — provision the FISH_API_KEY secret for the gateway's Fish
# Audio TTS fallback (services/gateway/src/services/tts/fish.ts).
#
# WHY THIS EXISTS
#
# No Claude Code session in this repo has `secretsmanager:CreateSecret`
# (CLAUDE.md's own established pattern — see setup-erp-bridge-staging.sh's
# header). This script is the exact, idempotent call an operator runs
# instead, matching the `vitana/gateway/<env>/<key-name>` naming convention
# every other API-key secret here already uses (`vitana/gateway/staging/
# deepseek-api-key`, `.../openai-api-key`).
#
# WHAT IT DOES NOT DO
#
#   - It does NOT wire the secret into any ECS task definition. Unlike
#     DEEPSEEK_API_KEY, this is deliberately left out of
#     AWS-STAGE-DEPLOY-GATEWAY.yml's hard-fail secret-resolution loop for
#     this PR: that loop `exit 1`s the ENTIRE staging deploy if a listed
#     secret is not found, and this session has no way to confirm the
#     secret exists before merging code that would add it there. Add
#     `"SEC_FISH:vitana/gateway/<env>/fish-api-key"` to that loop and the
#     matching `{name:"FISH_API_KEY", valueFrom:$SEC_FISH}` /
#     `{name:"TTS_FISH_FALLBACK_ENABLED", value:"true"}` pair to the
#     task-def jq block ONLY after running this script with `--apply` and
#     confirming the secret exists.
#   - It never touches production. Pass `--env staging` (default) or
#     `--env prod` explicitly; nothing here defaults to prod.
#
# USAGE
#
#   scripts/aws/setup-fish-audio-secret.sh --env staging                      # dry run
#   FISH_API_KEY_VALUE=sk-fish-... scripts/aws/setup-fish-audio-secret.sh \
#       --env staging --apply
#   scripts/aws/setup-fish-audio-secret.sh --env staging status

set -euo pipefail

REGION="eu-central-1"
ENV_NAME="staging"
ACTION=""
APPLY=0

say() { echo "[setup-fish-audio-secret] $*"; }
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

SECRET_NAME="vitana/gateway/${ENV_NAME}/fish-api-key"

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
      say "$SECRET_NAME already exists — this script never overwrites a live key. Use the AWS Console/CLI to rotate it."
      exit 0
    fi

    if [[ "$APPLY" != "1" ]]; then
      plan "create secret $SECRET_NAME (value from \$FISH_API_KEY_VALUE)"
      say "Dry run only. Re-run with FISH_API_KEY_VALUE=<key> ... --apply to actually create it."
      exit 0
    fi

    if [[ -z "${FISH_API_KEY_VALUE:-}" ]]; then
      echo "FISH_API_KEY_VALUE must be set in the environment for --apply." >&2
      exit 1
    fi

    aws secretsmanager create-secret \
      --region "$REGION" \
      --name "$SECRET_NAME" \
      --description "VTID-03970 Fish Audio TTS API key ($ENV_NAME) — language-coverage fallback for Polly (Serbian, etc.)" \
      --secret-string "$FISH_API_KEY_VALUE" \
      --tags Key=vtid,Value=VTID-03970 >/dev/null
    say "Created $SECRET_NAME."
    say "Next: wire it into AWS-STAGE-DEPLOY-GATEWAY.yml's secret-resolution loop and task-def jq block (see this file's header), then dispatch a staging deploy."
    ;;
esac
