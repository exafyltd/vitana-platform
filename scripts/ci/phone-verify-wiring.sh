#!/usr/bin/env bash
#
# VTID-05127 — production wiring for phone verification (VTID-05095).
# Called by AWS-PROD-DEPLOY-GATEWAY.yml step "Build task-definition (phone
# verification)"; tested by services/gateway/test/vtid-05127-phone-verify-switch-wiring.test.ts.
#
# Usage: phone-verify-wiring.sh <task-definition.json>   (rewritten in place)
# Env:
#   PHONE_VERIFY_ARN      repo variable PHONE_VERIFY_HMAC_SECRET_PROD_ARN: empty,
#                         or the full ARN of vitana/gateway/prod/phone-verify-hmac
#                         (the prod deploy role has no secretsmanager:Describe*,
#                         so the ARN cannot be looked up here)
#   PHONE_VERIFY_ENABLED_VAR  repo variable PHONE_VERIFY_PROD_ENABLED: exact
#                         'true' switches the feature on; anything else is off
#
#   ARN set   + 'true'  -> PHONE_VERIFY_HMAC_SECRET secret ref, PHONE_VERIFY_ENABLED=true
#   ARN set   + other   -> secret ref, PHONE_VERIFY_ENABLED=false
#   ARN empty + 'true'  -> exit 1 (on without its secret = 503 on every route)
#   ARN empty + other   -> PHONE_VERIFY_ENABLED=false, no secret ref
#   ARN not the prod phone-verify-hmac secret -> exit 1
set -euo pipefail

F="${1:?usage: phone-verify-wiring.sh <task-definition.json>}"
ARN="${PHONE_VERIFY_ARN:-}"
WANT="${PHONE_VERIFY_ENABLED_VAR:-}"
RE='^arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/gateway/prod/phone-verify-hmac-[A-Za-z0-9]{6}$'

if [ -n "$ARN" ] && ! [[ "$ARN" =~ $RE ]]; then
  echo "::error::PHONE_VERIFY_HMAC_SECRET_PROD_ARN is not the ARN of vitana/gateway/prod/phone-verify-hmac"
  exit 1
fi
ENABLED=false
if [ "$WANT" = "true" ]; then
  if [ -z "$ARN" ]; then
    echo "::error::PHONE_VERIFY_PROD_ENABLED=true but PHONE_VERIFY_HMAC_SECRET_PROD_ARN is empty — every /api/v1/me/phone route would answer 503 PHONE_VERIFY_MISCONFIGURED. Run scripts/aws/setup-phone-verify-sms.sh --env prod --apply and set the variable first."
    exit 1
  fi
  ENABLED=true
fi

jq --arg A "$ARN" --arg E "$ENABLED" '
  .containerDefinitions[0].environment |=
    ( [ (. // [])[] | select(.name != "PHONE_VERIFY_ENABLED") ] + [ {name:"PHONE_VERIFY_ENABLED", value:$E} ] )
  | .containerDefinitions[0].secrets |=
    ( [ (. // [])[] | select(.name != "PHONE_VERIFY_HMAC_SECRET") ]
      + ( if $A == "" then [] else [ {name:"PHONE_VERIFY_HMAC_SECRET", valueFrom:$A} ] end ) )' "$F" > "$F.tmp"
mv "$F.tmp" "$F"
echo "Phone verification: PHONE_VERIFY_ENABLED=$ENABLED, secret $( [ -n "$ARN" ] && echo wired || echo 'not wired')"
