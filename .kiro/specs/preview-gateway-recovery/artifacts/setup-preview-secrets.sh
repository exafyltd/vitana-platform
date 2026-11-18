#!/usr/bin/env bash
# setup-preview-secrets.sh — owner/admin-run, same pattern as scripts/aws/setup-*-secret.sh:
# dry run by default, --apply to write, staging only, account/region pinned, values never printed.
#
# Creates the two staging-only credentials the isolated preview gateway needs:
#   vitana/gateway/staging/postgrest-service-role-key  HS256 JWT {"role":"service_role"} signed with
#        vitana/gateway/staging/postgrest-jwt-secret (the staging PostgREST secret, VTID-05803 tag).
#        Accepted ONLY by a PostgREST that verifies with that secret (proxy revision 21, see plan.md §4).
#   vitana/gateway/staging/preview-sparring-token      random 48-byte token; the preview's
#        GATEWAY_SERVICE_TOKEN and, copied by --github, the repo secret PLAN_SPAR_GATEWAY_TOKEN.
#
# Refuses to mint the JWT if the staging PostgREST secret equals the production Supabase JWT secret
# (compared by sha256 inside this process; neither value is printed or written to disk).
#
# Usage: setup-preview-secrets.sh [--apply] [--github] [--vtid VTID-xxxxx]
set -euo pipefail
ACCOUNT=472838866351; REGION=eu-central-1
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION
APPLY=0; GITHUB=0; VTID="VTID-05803"
while [ $# -gt 0 ]; do case "$1" in --apply) APPLY=1;; --github) GITHUB=1;; --vtid) VTID="$2"; shift;; *) echo "unknown $1" >&2; exit 2;; esac; shift; done
[ "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || { echo "wrong account" >&2; exit 1; }

STAGING_JWT=vitana/gateway/staging/postgrest-jwt-secret
PROD_JWT=vitana/supabase/prod/jwt-secret
SRK=vitana/gateway/staging/postgrest-service-role-key
TOK=vitana/gateway/staging/preview-sparring-token
TAGS="Key=Environment,Value=staging Key=Purpose,Value=preview-sparring Key=VTID,Value=$VTID"

exists() { aws secretsmanager describe-secret --secret-id "$1" >/dev/null 2>&1; }
for s in "$SRK" "$TOK"; do exists "$s" && echo "exists: $s" || echo "missing: $s"; done
[ $APPLY = 1 ] || { echo "dry run — re-run with --apply to create the missing ones"; exit 0; }

if ! exists "$SRK"; then
  SECRET=$(aws secretsmanager get-secret-value --secret-id "$STAGING_JWT" --query SecretString --output text)
  PROD=$(aws secretsmanager get-secret-value --secret-id "$PROD_JWT" --query SecretString --output text)
  PRODSUM=$(printf '%s' "$PROD" | sha256sum | cut -c1-64); unset PROD
  if [ -z "$SECRET" ] || [ "$(printf '%s' "$SECRET" | sha256sum | cut -c1-64)" = "$PRODSUM" ]; then
    unset SECRET; echo "REFUSED: $STAGING_JWT equals the production JWT secret; a key signed with it would be production-valid" >&2; exit 1
  fi
  JWT=$(SECRET="$SECRET" node -e '
    const c=require("crypto"); const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
    const now=Math.floor(Date.now()/1000);
    const h=b({alg:"HS256",typ:"JWT"}), p=b({role:"service_role",iss:"vitana-aurora-staging",aud:"preview-sparring",iat:now,exp:now+180*86400});
    const s=c.createHmac("sha256",process.env.SECRET).update(h+"."+p).digest("base64url");
    process.stdout.write(h+"."+p+"."+s);')
  unset SECRET
  aws secretsmanager create-secret --name "$SRK" --secret-string "$JWT" --tags $TAGS \
    --description "staging-only service_role JWT for the preview gateway -> staging PostgREST (expires in 180 days)" >/dev/null
  unset JWT; echo "created $SRK"
fi

if ! exists "$TOK"; then
  aws secretsmanager create-secret --name "$TOK" --secret-string "$(openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_')" --tags $TAGS \
    --description "preview gateway GATEWAY_SERVICE_TOKEN; mirrored to GitHub secret PLAN_SPAR_GATEWAY_TOKEN" >/dev/null
  echo "created $TOK"
fi

if [ $GITHUB = 1 ]; then
  aws secretsmanager get-secret-value --secret-id "$TOK" --query SecretString --output text \
    | gh secret set PLAN_SPAR_GATEWAY_TOKEN --repo exafyltd/vitana-platform >/dev/null
  echo "GitHub secret PLAN_SPAR_GATEWAY_TOKEN set (value piped, not printed)"
fi
