#!/usr/bin/env bash
#
# VTID-04133 — provision the OPERATOR_MACHINE_AUTH_TOKEN secret for the
# Operator Console's machine-to-machine auth path
# (services/gateway/src/services/operator-machine-auth.ts).
#
# WHY THIS EXISTS
#
# `autopilot_run_task`/`autopilot_execute_task` correctly require a
# verified exafy_admin session (VTID-03851) — but the only credential that
# satisfies that gate has been a human's Supabase password. Testing the
# on-ramp end-to-end therefore meant either a person signing in through the
# browser, or an automated caller holding a real user's password — the
# second of which this codebase (and this session's own harness) treats as
# a secret-handling action to avoid, not automate around. This script
# provisions a SEPARATE, narrower, purpose-built credential instead: a
# random static token presented in its own header
# (`X-Operator-Machine-Token`), resolved server-side to a clearly-synthetic
# identity (`operator-machine-test-harness`) that can never collide with a
# real account and is never inserted into `user_tenants`/`profiles`.
#
# No Claude Code session in this repo has `secretsmanager:CreateSecret`
# (the same established constraint as every other provider secret here —
# see setup-fish-audio-secret.sh's header) — this script is the exact,
# idempotent call an operator runs instead, following the same
# `vitana/gateway/<env>/<key-name>` naming convention.
#
# WHAT IT DOES NOT DO
#
#   - It does NOT wire the secret (or OPERATOR_MACHINE_AUTH_ENABLED) into
#     any ECS task definition. Deliberately left out of
#     AWS-STAGE-DEPLOY-GATEWAY.yml in this same PR, same reasoning as
#     FISH_API_KEY: that workflow's secret-resolution loop hard-fails the
#     whole staging deploy if a listed secret is missing, and this session
#     has no way to confirm the secret exists before merging code that
#     would require it. Provision first, confirm with `status`, THEN add
#     `"SEC_OPERATOR_MACHINE_AUTH:vitana/gateway/<env>/operator-machine-auth-token"`
#     to that loop plus the matching
#     `{name:"OPERATOR_MACHINE_AUTH_TOKEN", valueFrom:$SEC_OPERATOR_MACHINE_AUTH}` /
#     `{name:"OPERATOR_MACHINE_AUTH_ENABLED", value:"true"}` pair to the
#     task-def jq block — never the other way round (CLAUDE.md IF-THEN 31's
#     ordering discipline, same as Bedrock).
#   - It never touches production. Pass `--env staging` (default) or
#     `--env prod` explicitly; nothing here defaults to prod. This
#     credential exists for automated STAGING testing — there is no
#     product reason to ever provision it for prod.
#   - It never prints the generated token to a log an operator didn't
#     explicitly ask for — `provision --apply` prints it once, to stdout,
#     for the operator to hand to whichever session/harness needs it.
#
# USAGE
#
#   scripts/aws/setup-operator-machine-auth-secret.sh --env staging          # dry run
#   scripts/aws/setup-operator-machine-auth-secret.sh --env staging --apply  # generates + creates
#   scripts/aws/setup-operator-machine-auth-secret.sh --env staging status

set -euo pipefail

REGION="eu-central-1"
ENV_NAME="staging"
ACTION=""
APPLY=0

say() { echo "[setup-operator-machine-auth-secret] $*"; }
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

SECRET_NAME="vitana/gateway/${ENV_NAME}/operator-machine-auth-token"

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
      say "$SECRET_NAME already exists — this script never overwrites a live token. Use the AWS Console/CLI to rotate it, then update whichever session/harness holds the old value."
      exit 0
    fi

    if [[ "$APPLY" != "1" ]]; then
      plan "generate a random 48-byte token and create secret $SECRET_NAME"
      say "Dry run only. Re-run with --apply to actually generate and create it."
      exit 0
    fi

    TOKEN_VALUE=$(openssl rand -hex 48)

    aws secretsmanager create-secret \
      --region "$REGION" \
      --name "$SECRET_NAME" \
      --description "VTID-04133 Operator Console machine-to-machine auth token ($ENV_NAME) — lets an automated test harness pass VTID-03851's exafy_admin gate without a human password" \
      --secret-string "$TOKEN_VALUE" \
      --tags Key=vtid,Value=VTID-04133 >/dev/null
    say "Created $SECRET_NAME."
    say ""
    say "Token (hand this to the session/harness that needs it — never commit it):"
    echo "$TOKEN_VALUE"
    say ""
    say "Next: wire it into AWS-STAGE-DEPLOY-GATEWAY.yml's secret-resolution loop and task-def jq block (see this file's header), confirm the deploy picks it up, then send requests with header 'X-Operator-Machine-Token: <token>' to POST /api/v1/operator/chat."
    ;;
esac
