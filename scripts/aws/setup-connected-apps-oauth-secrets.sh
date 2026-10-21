#!/usr/bin/env bash
#
# VTID-04507 — provision the Connected Apps sign-in secrets for the gateway.
#
# Each member connects their own Google / Microsoft / Apple account with one
# tap. For Google and Microsoft that tap opens the provider's own consent
# screen, and the provider only shows it to an app it knows: Vitanaland's
# OAuth client (a client ID + secret, registered once in the Google Cloud
# Console and the Azure portal). Apple offers no such screen for iCloud mail,
# calendar or contacts, so members paste an app-specific password once; the
# gateway stores it encrypted with AI_CREDENTIALS_ENC_KEY.
#
# This script puts those five values into AWS Secrets Manager under
# vitana/gateway/<env>/…, where AWS-STAGE-DEPLOY-GATEWAY.yml's
# "Resolve Connected Apps sign-in config" step picks them up on the next
# deploy. A secret that does not exist is simply not wired; it never fails
# the deploy. The client IDs/secrets come from the consoles (see
# docs/CONNECTED-APPS-OAUTH-SETUP.md); the encryption key is generated here.
#
# No Claude Code session has secretsmanager:CreateSecret, so an operator
# runs this. Nothing defaults to prod.
#
# USAGE
#   export GOOGLE_OAUTH_CLIENT_ID=… GOOGLE_OAUTH_CLIENT_SECRET=…
#   export MICROSOFT_OAUTH_CLIENT_ID=… MICROSOFT_OAUTH_CLIENT_SECRET=…
#   scripts/aws/setup-connected-apps-oauth-secrets.sh --env staging status
#   scripts/aws/setup-connected-apps-oauth-secrets.sh --env staging provision          # dry run
#   scripts/aws/setup-connected-apps-oauth-secrets.sh --env staging provision --apply
#
# Unset client variables are skipped, so Google, Microsoft and the key can be
# provisioned one at a time. Existing secrets are never overwritten — rotate
# them with `aws secretsmanager put-secret-value`. Afterwards, redeploy the
# gateway (any push to main under services/gateway/**, or a workflow_dispatch
# of AWS-STAGE-DEPLOY-GATEWAY.yml) so the new task definition picks them up.

set -euo pipefail

REGION="eu-central-1"
ENV_NAME="staging"
ACTION=""
APPLY=0

say() { echo "[setup-connected-apps-oauth-secrets] $*"; }

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

PREFIX="vitana/gateway/${ENV_NAME}"
# env var name : secret suffix
ENTRIES=(
  "GOOGLE_OAUTH_CLIENT_ID:google-oauth-client-id"
  "GOOGLE_OAUTH_CLIENT_SECRET:google-oauth-client-secret"
  "MICROSOFT_OAUTH_CLIENT_ID:microsoft-oauth-client-id"
  "MICROSOFT_OAUTH_CLIENT_SECRET:microsoft-oauth-client-secret"
  "AI_CREDENTIALS_ENC_KEY:credentials-enc-key"
)

exists() { aws secretsmanager describe-secret --region "$REGION" --secret-id "$1" >/dev/null 2>&1; }

for entry in "${ENTRIES[@]}"; do
  VAR="${entry%%:*}"; NAME="${PREFIX}/${entry#*:}"
  if [[ "$ACTION" == "status" ]]; then
    if exists "$NAME"; then say "EXISTS  $NAME ($VAR)"; else say "MISSING $NAME ($VAR)"; fi
    continue
  fi

  if exists "$NAME"; then
    say "skip    $NAME already exists (never overwritten)"
    continue
  fi

  if [[ "$VAR" == "AI_CREDENTIALS_ENC_KEY" ]]; then
    VALUE="__generate__"
  else
    VALUE="${!VAR:-}"
    if [[ -z "$VALUE" ]]; then
      say "skip    $NAME — \$$VAR is not set"
      continue
    fi
  fi

  if [[ "$APPLY" != "1" ]]; then
    if [[ "$VALUE" == "__generate__" ]]; then
      say "[dry-run] generate a 32-byte key and create $NAME"
    else
      say "[dry-run] create $NAME from \$$VAR"
    fi
    continue
  fi

  # 32 bytes as 64 hex chars — the only shape ai-credential-crypto accepts.
  [[ "$VALUE" == "__generate__" ]] && VALUE=$(openssl rand -hex 32)
  aws secretsmanager create-secret \
    --region "$REGION" \
    --name "$NAME" \
    --description "VTID-04507 Connected Apps sign-in ($ENV_NAME): $VAR" \
    --secret-string "$VALUE" \
    --tags Key=vtid,Value=VTID-04507 >/dev/null
  say "created $NAME"
done

if [[ "$ACTION" == "provision" && "$APPLY" != "1" ]]; then
  say "Dry run only. Re-run with --apply to create the secrets listed above."
fi
if [[ "$ACTION" == "provision" && "$APPLY" == "1" ]]; then
  say "Done. Redeploy the $ENV_NAME gateway so the task definition picks these up."
fi
