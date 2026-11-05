#!/usr/bin/env bash
#
# VTID-05541 (plan eng-gitlab-m2 §3.5, lane scm-webhook) — give the staging gateway the signing key of the GitLab
# project webhooks, so routes/internal-gitlab-webhook.ts can verify them.
#
# Owner-run (AWS CloudShell in the production account 472838866351). The value is generated in the engineering
# account 841276716213 by the GitLab settings sync (eng-gitlab-m2 §3.3) as vitana/engineering/gitlab/webhook-signing-token.
# This script reads it there through a role in that account and writes it here as
# vitana/gateway/staging/gitlab-webhook-signing-token. The value is never printed, never put in an argument and never
# written to a file; it moves through one shell variable.
#
# Staging wiring is automatic: AWS-STAGE-DEPLOY-GATEWAY.yml's "Resolve GitLab webhook signing key" step wires
# GITLAB_WEBHOOK_SIGNING_TOKEN when the secret exists; absent, the deploy is unaffected. Production is not wired in
# this milestone.
#
# USAGE
#   scripts/aws/setup-gitlab-webhook-secret.sh status
#   scripts/aws/setup-gitlab-webhook-secret.sh copy            # dry run: prints what it would do
#   scripts/aws/setup-gitlab-webhook-secret.sh copy --apply    # reads in the engineering account, writes staging
#   options: --eng-role-arn <arn>  (default arn:aws:iam::841276716213:role/OrganizationAccountAccessRole)

set -euo pipefail

REGION="eu-central-1"
PROD_ACCOUNT="472838866351"
ENG_ACCOUNT="841276716213"
ENG_ROLE_ARN="arn:aws:iam::${ENG_ACCOUNT}:role/OrganizationAccountAccessRole"
SOURCE_SECRET="vitana/engineering/gitlab/webhook-signing-token"
TARGET_SECRET="vitana/gateway/staging/gitlab-webhook-signing-token"
ACTION=""
APPLY=0

say() { echo "[setup-gitlab-webhook-secret] $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    status|copy) ACTION="$1"; shift ;;
    --apply) APPLY=1; shift ;;
    --eng-role-arn) ENG_ROLE_ARN="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ACTION" ]]; then
  echo "Usage: $0 {status|copy} [--apply] [--eng-role-arn <arn>]" >&2
  exit 1
fi

# CLAUDE.md IF-THEN 11: stop on the wrong account or region.
CALLER_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$CALLER_ACCOUNT" != "$PROD_ACCOUNT" ]]; then
  echo "Refusing: this shell is in account $CALLER_ACCOUNT, the staging gateway's secret lives in $PROD_ACCOUNT." >&2
  exit 1
fi
if [[ "${ENG_ROLE_ARN}" != arn:aws:iam::${ENG_ACCOUNT}:role/* ]]; then
  echo "Refusing: --eng-role-arn must be a role in the engineering account $ENG_ACCOUNT." >&2
  exit 1
fi

target_exists() { aws secretsmanager describe-secret --region "$REGION" --secret-id "$TARGET_SECRET" >/dev/null 2>&1; }

case "$ACTION" in
  status)
    if target_exists; then say "EXISTS: $TARGET_SECRET ($PROD_ACCOUNT, $REGION)"; else say "MISSING: $TARGET_SECRET"; fi
    ;;
  copy)
    if [[ "$APPLY" -ne 1 ]]; then
      say "[dry-run] would assume $ENG_ROLE_ARN and read $SOURCE_SECRET ($ENG_ACCOUNT, $REGION)"
      if target_exists; then
        say "[dry-run] would put a new value into $TARGET_SECRET ($PROD_ACCOUNT, $REGION)"
      else
        say "[dry-run] would create $TARGET_SECRET ($PROD_ACCOUNT, $REGION)"
      fi
      say "[dry-run] re-run with --apply to copy it; the value is never printed"
      exit 0
    fi
    CREDS="$(aws sts assume-role --role-arn "$ENG_ROLE_ARN" --role-session-name vitana-gitlab-webhook-secret \
      --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
    read -r ENG_KEY ENG_SECRET ENG_TOKEN <<<"$CREDS"
    unset CREDS
    VALUE="$(AWS_ACCESS_KEY_ID="$ENG_KEY" AWS_SECRET_ACCESS_KEY="$ENG_SECRET" AWS_SESSION_TOKEN="$ENG_TOKEN" \
      aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SOURCE_SECRET" --query SecretString --output text)"
    unset ENG_KEY ENG_SECRET ENG_TOKEN
    if [[ "$VALUE" != whsec_* ]]; then
      unset VALUE
      echo "Refusing: $SOURCE_SECRET is not in the whsec_<base64> form the route expects." >&2
      exit 1
    fi
    if target_exists; then
      aws secretsmanager put-secret-value --region "$REGION" --secret-id "$TARGET_SECRET" \
        --secret-string "$VALUE" >/dev/null
      say "Updated $TARGET_SECRET"
    else
      aws secretsmanager create-secret --region "$REGION" --name "$TARGET_SECRET" \
        --description "GitLab webhook signing key for the staging gateway (VTID-05541)" \
        --secret-string "$VALUE" >/dev/null
      say "Created $TARGET_SECRET"
    fi
    unset VALUE
    say "The next staging gateway deploy wires GITLAB_WEBHOOK_SIGNING_TOKEN."
    ;;
esac
