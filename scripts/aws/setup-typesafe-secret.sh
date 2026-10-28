#!/usr/bin/env bash
#
# VTID-04473 — provision TYPESAFE_API_KEY for the gateway's Jev typed
# decisions (services/gateway/src/services/jev/).
#
# Owner-run: no Claude Code session holds secretsmanager:CreateSecret. The
# value is read from the TYPESAFE_API_KEY_VALUE environment variable, never
# from an argument, so it does not land in shell history or `ps`.
#
# Staging wiring is automatic and optional: AWS-STAGE-DEPLOY-GATEWAY.yml's
# "Resolve Jev decision config" step wires the key and sets
# JEV_DECISIONS_ENABLED=true only when vitana/gateway/staging/typesafe-api-key
# exists; absent, the deploy is unaffected and Jev stays inert. Production is
# not wired by any workflow yet — `--env prod` only creates the secret.
#
# USAGE
#   scripts/aws/setup-typesafe-secret.sh status  --env staging
#   scripts/aws/setup-typesafe-secret.sh provision --env staging            # dry run
#   TYPESAFE_API_KEY_VALUE=... scripts/aws/setup-typesafe-secret.sh provision --env staging --apply

set -euo pipefail

REGION="eu-central-1"
ENV_NAME="staging"
ACTION=""
APPLY=0

say() { echo "[setup-typesafe-secret] $*"; }

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

SECRET_NAME="vitana/gateway/${ENV_NAME}/typesafe-api-key"
exists() { aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null 2>&1; }

case "$ACTION" in
  status)
    if exists; then say "EXISTS: $SECRET_NAME"; else say "MISSING: $SECRET_NAME"; fi
    ;;
  provision)
    if [[ "$APPLY" -ne 1 ]]; then
      say "[dry-run] would create or update $SECRET_NAME in $REGION from \$TYPESAFE_API_KEY_VALUE"
      say "[dry-run] re-run with --apply to write it"
      exit 0
    fi
    if [[ -z "${TYPESAFE_API_KEY_VALUE:-}" ]]; then
      echo "TYPESAFE_API_KEY_VALUE is not set." >&2
      exit 1
    fi
    if exists; then
      aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_NAME" \
        --secret-string "$TYPESAFE_API_KEY_VALUE" >/dev/null
      say "Updated $SECRET_NAME"
    else
      aws secretsmanager create-secret --region "$REGION" --name "$SECRET_NAME" \
        --description "TypeSafe System One (Jev) API key for the gateway (VTID-04473)" \
        --secret-string "$TYPESAFE_API_KEY_VALUE" >/dev/null
      say "Created $SECRET_NAME"
    fi
    [[ "$ENV_NAME" == "staging" ]] && say "The next staging gateway deploy wires it and enables Jev."
    ;;
esac
