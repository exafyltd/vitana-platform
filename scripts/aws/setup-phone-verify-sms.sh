#!/usr/bin/env bash
#
# VTID-05127 — everything the gateway needs to send phone-verification SMS
# codes (VTID-05095), in one idempotent script. Runbook:
# docs/validation/VTID-05127/SWITCH-ON.md.
#
# WHAT IT DOES (--apply)
#
#   1. Secrets Manager vitana/gateway/<env>/phone-verify-hmac: 64 hex chars
#      (32 random bytes) for PHONE_VERIFY_HMAC_SECRET. Never printed. An
#      existing secret is kept; --rotate replaces it (only codes still open,
#      at most 10 minutes old, stop matching).
#   2. Inline policy vitana-phone-verify-sms-VTID-05127 on vitana-ecs-task-role
#      (staging and production task definitions share this role):
#      sms-voice:SendTextMessage on this account and region only.
#   3. --monthly-limit-usd N: the End User Messaging SMS monthly spend limit.
#      It is ACCOUNT-WIDE. Today services/gateway/src/services/
#      phone-verification/sms-sender.ts is the only SMS sender in this repo;
#      a second sender would share the limit.
#   4. --sender-id NAME: requests the alphanumeric sender ID for DE, AT, CH
#      (TRANSACTIONAL). Checks describe-sender-ids first; an existing
#      registration with TRANSACTIONAL is kept, a conflicting one is reported
#      and never overwritten.
#
# What it cannot do: leave the SMS sandbox. That is an AWS support case
# (SMS production access, eu-central-1). `status` shows the tier.
#
# CREDENTIALS
#
# Run with your own admin credentials (CloudShell), never the task role. No
# Claude Code session has these rights (permissions boundary, see
# setup-operator-agent-task-role-grants.sh). Needs: secretsmanager:CreateSecret/
# PutSecretValue/DescribeSecret, iam:PutRolePolicy/GetRolePolicy on the role,
# sms-voice:DescribeAccountAttributes/DescribeSpendLimits/DescribeSenderIds/
# SetTextMessageSpendLimitOverride/RequestSenderId, sts:GetCallerIdentity.
#
# USAGE
#
#   scripts/aws/setup-phone-verify-sms.sh --env prod                 # dry run
#   scripts/aws/setup-phone-verify-sms.sh --env prod --apply \
#       --monthly-limit-usd 50 --sender-id Vitana
#   scripts/aws/setup-phone-verify-sms.sh --env prod status
#
set -euo pipefail

REGION="eu-central-1"
ACCOUNT_ID="472838866351"
ROLE_NAME="vitana-ecs-task-role"
POLICY_NAME="vitana-phone-verify-sms-VTID-05127"
COUNTRIES=(DE AT CH)
ENV_NAME=""
ACTION="provision"
APPLY=0
ROTATE=0
LIMIT=""
SENDER=""

say() { echo "[setup-phone-verify-sms] $*"; }
die() { echo "[setup-phone-verify-sms] ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    provision|status) ACTION="$1"; shift ;;
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --rotate) ROTATE=1; shift ;;
    --monthly-limit-usd) LIMIT="${2:-}"; shift 2 ;;
    --sender-id) SENDER="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$ENV_NAME" in staging|prod) ;; *) die "--env must be staging or prod" ;; esac
if [[ -n "$LIMIT" ]] && ! [[ "$LIMIT" =~ ^[1-9][0-9]{0,5}$ ]]; then die "--monthly-limit-usd must be a whole number of dollars"; fi
if [[ -n "$SENDER" ]]; then
  if ! [[ "$SENDER" =~ ^[A-Za-z0-9]{3,11}$ ]] || [[ "$SENDER" =~ ^[0-9]+$ ]]; then
    die "--sender-id must be 3-11 letters/digits with at least one letter"
  fi
fi

SECRET_ID="vitana/gateway/${ENV_NAME}/phone-verify-hmac"
AWSR=(aws --region "$REGION")

POLICY_DOC=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PhoneVerificationSendSmsVTID05127",
      "Effect": "Allow",
      "Action": ["sms-voice:SendTextMessage"],
      "Resource": "arn:aws:sms-voice:${REGION}:${ACCOUNT_ID}:*"
    }
  ]
}
JSON
)

# Refuse any other account (and the region is fixed above). Runs before any
# AWS call that writes, in every mode.
check_account() {
  local acct
  acct=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
  [[ -n "$acct" ]] || die "cannot read the AWS account (no credentials?) — nothing was changed"
  [[ "$acct" == "$ACCOUNT_ID" ]] || die "account $acct is not $ACCOUNT_ID — nothing was changed"
  say "account $acct, region $REGION"
}

show_status() {
  local tier
  tier=$("${AWSR[@]}" pinpoint-sms-voice-v2 describe-account-attributes \
    --query "AccountAttributes[?Name=='ACCOUNT_TIER'].Value | [0]" --output text 2>/dev/null || echo unknown)
  say "SMS account tier: $tier"
  if [[ "$tier" == "SANDBOX" ]]; then
    say "  still in the SMS sandbox: codes reach only verified destination numbers."
    say "  Open an AWS support case for SMS production access in $REGION before switching the feature on."
  fi
  say "SMS spend limit (USD/month):"
  "${AWSR[@]}" pinpoint-sms-voice-v2 describe-spend-limits \
    --query "SpendLimits[?Name=='TEXT_MESSAGE_MONTHLY_SPEND_LIMIT'].{enforced:EnforcedLimit,max:MaxLimit,overridden:Overridden}" \
    --output json 2>/dev/null || say "  (cannot read)"
  if [[ -n "$SENDER" ]]; then
    say "sender ID $SENDER:"
    "${AWSR[@]}" pinpoint-sms-voice-v2 describe-sender-ids --filters "Name=sender-id,Values=$SENDER" \
      --query "SenderIds[].{country:IsoCountryCode,types:MessageTypes}" --output json 2>/dev/null || say "  (cannot read)"
  fi
  local arn
  arn=$("${AWSR[@]}" secretsmanager describe-secret --secret-id "$SECRET_ID" --query ARN --output text 2>/dev/null || true)
  if [[ -n "$arn" && "$arn" != "None" ]]; then
    say "secret $SECRET_ID: present"
    if [[ "$ENV_NAME" == "prod" ]]; then
      say "  repository variable PHONE_VERIFY_HMAC_SECRET_PROD_ARN = $arn"
    fi
  else
    say "secret $SECRET_ID: absent"
  fi
  if aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" >/dev/null 2>&1; then
    say "inline policy $POLICY_NAME on $ROLE_NAME: present"
  else
    say "inline policy $POLICY_NAME on $ROLE_NAME: absent"
  fi
}

ensure_secret() {
  if "${AWSR[@]}" secretsmanager describe-secret --secret-id "$SECRET_ID" >/dev/null 2>&1; then
    if [[ "$ROTATE" -eq 1 ]]; then
      "${AWSR[@]}" secretsmanager put-secret-value --secret-id "$SECRET_ID" \
        --secret-string "$(openssl rand -hex 32)" >/dev/null
      say "secret $SECRET_ID rotated"
    else
      say "secret $SECRET_ID exists — kept (--rotate to replace)"
    fi
  else
    "${AWSR[@]}" secretsmanager create-secret --name "$SECRET_ID" \
      --description "Gateway PHONE_VERIFY_HMAC_SECRET for SMS verification codes (VTID-05095/05127)" \
      --secret-string "$(openssl rand -hex 32)" >/dev/null
    say "secret $SECRET_ID created"
  fi
}

ensure_sender_ids() {
  local c types
  for c in "${COUNTRIES[@]}"; do
    types=$("${AWSR[@]}" pinpoint-sms-voice-v2 describe-sender-ids \
      --filters "Name=sender-id,Values=$SENDER" "Name=iso-country-code,Values=$c" \
      --query "SenderIds[0].MessageTypes" --output text 2>/dev/null || true)
    if [[ -z "$types" || "$types" == "None" ]]; then
      "${AWSR[@]}" pinpoint-sms-voice-v2 request-sender-id --sender-id "$SENDER" \
        --iso-country-code "$c" --message-types TRANSACTIONAL >/dev/null
      say "sender ID $SENDER requested for $c (TRANSACTIONAL)"
    elif [[ "$types" == *TRANSACTIONAL* ]]; then
      say "sender ID $SENDER for $c exists with TRANSACTIONAL — kept"
    else
      say "WARNING: sender ID $SENDER for $c exists with message types '$types' — left unchanged; add TRANSACTIONAL in the AWS console"
    fi
  done
}

case "$ACTION" in
  status)
    check_account
    show_status
    ;;
  provision)
    say "env $ENV_NAME  secret $SECRET_ID  role $ROLE_NAME  policy $POLICY_NAME"
    echo "$POLICY_DOC" | jq .
    [[ -n "$LIMIT" ]] && say "monthly SMS spend limit -> $LIMIT USD (account-wide)"
    [[ -n "$SENDER" ]] && say "sender ID $SENDER for ${COUNTRIES[*]} (TRANSACTIONAL)"
    check_account
    if [[ "$APPLY" -ne 1 ]]; then
      say "dry run — nothing changed. Re-run with --apply."
      exit 0
    fi
    ensure_secret
    aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" --policy-document "$POLICY_DOC"
    say "inline policy $POLICY_NAME put on $ROLE_NAME"
    if [[ -n "$LIMIT" ]]; then
      "${AWSR[@]}" pinpoint-sms-voice-v2 set-text-message-spend-limit-override --monthly-limit "$LIMIT" >/dev/null
      say "monthly SMS spend limit set to $LIMIT USD"
    fi
    [[ -n "$SENDER" ]] && ensure_sender_ids
    show_status
    if [[ "$ENV_NAME" == "staging" ]]; then
      say "Next: the next staging gateway deploy wires the secret and sets PHONE_VERIFY_ENABLED=true."
    else
      say "Next: once the tier is PRODUCTION, set the repository variables PHONE_VERIFY_HMAC_SECRET_PROD_ARN (above) and PHONE_VERIFY_PROD_ENABLED=true, then publish."
    fi
    ;;
esac
