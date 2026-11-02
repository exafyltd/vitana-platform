#!/usr/bin/env bash
# setup-github-oidc-roles.sh — keyless GitHub Actions roles for staging, PR previews and the drift check, and the
# narrowed trust for the prod deploy role (plan eng-platform-p01, lane oidc-roles).
#
# WHO RUNS IT: the owner, with IAM admin rights in account 472838866351. No agent session runs --apply.
#
# DRY-RUN BY DEFAULT: without --apply the script only reads (get-role, list-*-policies) and prints what it would do.
#
# ROLES (trust and permission files in scripts/aws/iam/eng-platform-oidc-*.json, StringEquals on sub and aud only):
#   vitana-gha-staging-deploy  sub = vitana-platform main | vitana-v1 main. Permissions = a copy of the effective
#                              policies of IAM user claude-staging-validation when the script runs: its managed and
#                              inline policies, those of its groups, and its permissions boundary (same reach as the
#                              static keys it replaces, nothing new).
#   vitana-gha-v1-preview      sub = vitana-v1 pull_request. Preview bucket vitana-pr-previews + one CloudFront
#                              distribution invalidation (needs --preview-distribution-id).
#   vitana-gha-drift-readonly  sub = vitana-platform pull_request | main. Data API on vitana-aurora-prod with the
#                              read-only secret vitana/aurora/prod/claude-readonly only.
#
# PROD TRUST: --narrow-prod-trust <role-name> prints the live trust of that role (keep it: it is the rollback) and,
# with --apply, replaces it with eng-platform-oidc-prod-deploy-trust.json (sub = vitana-platform main only).
#
# NEVER: creates an access key, deletes the IAM user, or touches any role not named above.
#
# USAGE:
#   scripts/aws/setup-github-oidc-roles.sh [--apply] [--preview-distribution-id ID] [--narrow-prod-trust ROLE]
#                                          [--account ID]
# After --apply set the repository variables printed at the end (plan eng-platform-p01 §3).

set -euo pipefail

EXPECTED_ACCOUNT="472838866351"
APPLY=0
PREVIEW_DIST=""
PROD_ROLE=""
HERE="$(cd "$(dirname "$0")" && pwd)"
IAM_DIR="$HERE/iam"
STAGING_USER="claude-staging-validation"

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --preview-distribution-id) PREVIEW_DIST="${2:?needs an id}"; shift 2 ;;
    --narrow-prod-trust) PROD_ROLE="${2:?needs a role name}"; shift 2 ;;
    --account) EXPECTED_ACCOUNT="${2:?needs an id}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "aws CLI not found" >&2; exit 3; }
command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2; exit 3; }

ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]; then
  echo "refusing to run: caller account is '${ACCOUNT:-<no credentials>}', expected $EXPECTED_ACCOUNT" >&2
  exit 4
fi

PROVIDER_ARN="arn:aws:iam::$EXPECTED_ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
  echo "refusing to run: GitHub OIDC provider $PROVIDER_ARN does not exist (scripts/aws/README.md step 1)" >&2
  exit 5
fi

mode() { if [ "$APPLY" = 1 ]; then echo "APPLY"; else echo "DRY-RUN"; fi; }
say() { echo "[$(mode)] $*"; }

# ensure_role <name> <trust file> — create the role or replace its trust policy
ensure_role() {
  local name="$1" trust="$2"
  if aws iam get-role --role-name "$name" >/dev/null 2>&1; then
    say "role $name exists: trust policy -> $(basename "$trust")"
    if [ "$APPLY" = 1 ]; then
      aws iam update-assume-role-policy --role-name "$name" --policy-document "file://$trust"
    fi
  else
    say "create role $name with trust $(basename "$trust")"
    if [ "$APPLY" = 1 ]; then
      aws iam create-role --role-name "$name" --assume-role-policy-document "file://$trust" \
        --description "eng-platform-p01 keyless GitHub Actions role" --max-session-duration 3600 >/dev/null
    fi
  fi
}

# put_inline <role> <policy name> <policy json string>
put_inline() {
  local role="$1" pname="$2" doc="$3"
  say "inline policy $pname on $role: $(echo "$doc" | jq -c '[.Statement[].Action] | flatten')"
  if [ "$APPLY" = 1 ]; then
    aws iam put-role-policy --role-name "$role" --policy-name "$pname" --policy-document "$doc"
  fi
}

# --- 1. staging deploy role: same permissions as the static-key user ------------------------------------------------
STAGING_ROLE="vitana-gha-staging-deploy"
ensure_role "$STAGING_ROLE" "$IAM_DIR/eng-platform-oidc-staging-deploy-trust.json"
for arn in $(aws iam list-attached-user-policies --user-name "$STAGING_USER" --query 'AttachedPolicies[].PolicyArn' --output text); do
  say "attach managed policy $arn (copied from user $STAGING_USER)"
  if [ "$APPLY" = 1 ]; then aws iam attach-role-policy --role-name "$STAGING_ROLE" --policy-arn "$arn"; fi
done
for pname in $(aws iam list-user-policies --user-name "$STAGING_USER" --query 'PolicyNames[]' --output text); do
  doc="$(aws iam get-user-policy --user-name "$STAGING_USER" --policy-name "$pname" --query PolicyDocument --output json)"
  put_inline "$STAGING_ROLE" "$pname" "$doc"
done
# Group-inherited permissions (sparring R1-F2): the user's effective reach includes every group it belongs to.
for grp in $(aws iam list-groups-for-user --user-name "$STAGING_USER" --query 'Groups[].GroupName' --output text); do
  for arn in $(aws iam list-attached-group-policies --group-name "$grp" --query 'AttachedPolicies[].PolicyArn' --output text); do
    say "attach managed policy $arn (from group $grp of $STAGING_USER)"
    if [ "$APPLY" = 1 ]; then aws iam attach-role-policy --role-name "$STAGING_ROLE" --policy-arn "$arn"; fi
  done
  for pname in $(aws iam list-group-policies --group-name "$grp" --query 'PolicyNames[]' --output text); do
    doc="$(aws iam get-group-policy --group-name "$grp" --policy-name "$pname" --query PolicyDocument --output json)"
    put_inline "$STAGING_ROLE" "group-$grp-$pname" "$doc"
  done
done
# A permissions boundary on the user caps its reach; the role gets the same cap.
BOUNDARY="$(aws iam get-user --user-name "$STAGING_USER" --query 'User.PermissionsBoundary.PermissionsBoundaryArn' --output text)"
if [ -n "$BOUNDARY" ] && [ "$BOUNDARY" != "None" ]; then
  say "permissions boundary $BOUNDARY on $STAGING_ROLE (copied from $STAGING_USER)"
  if [ "$APPLY" = 1 ]; then
    aws iam put-role-permissions-boundary --role-name "$STAGING_ROLE" --permissions-boundary "$BOUNDARY"
  fi
fi

# --- 2. vitana-v1 PR preview role ------------------------------------------------------------------------------------
PREVIEW_ROLE="vitana-gha-v1-preview"
if [ -z "$PREVIEW_DIST" ]; then
  say "skip $PREVIEW_ROLE: pass --preview-distribution-id (the value of vitana-v1 secret PREVIEW_CF_DISTRIBUTION_ID)"
else
  ensure_role "$PREVIEW_ROLE" "$IAM_DIR/eng-platform-oidc-v1-preview-trust.json"
  doc="$(sed "s/\${PREVIEW_CF_DISTRIBUTION_ID}/$PREVIEW_DIST/" "$IAM_DIR/eng-platform-oidc-v1-preview-policy.json")"
  put_inline "$PREVIEW_ROLE" "eng-platform-v1-preview" "$doc"
fi

# --- 3. drift-check read-only role -----------------------------------------------------------------------------------
DRIFT_ROLE="vitana-gha-drift-readonly"
ensure_role "$DRIFT_ROLE" "$IAM_DIR/eng-platform-oidc-drift-readonly-trust.json"
put_inline "$DRIFT_ROLE" "eng-platform-drift-readonly" "$(cat "$IAM_DIR/eng-platform-oidc-drift-readonly-policy.json")"

# --- 4. prod deploy role trust (opt-in) ------------------------------------------------------------------------------
if [ -n "$PROD_ROLE" ]; then
  echo "---- live trust of $PROD_ROLE (save this: it is the rollback) ----"
  aws iam get-role --role-name "$PROD_ROLE" --query Role.AssumeRolePolicyDocument --output json
  echo "---- new trust ----"
  cat "$IAM_DIR/eng-platform-oidc-prod-deploy-trust.json"
  say "replace trust of $PROD_ROLE"
  if [ "$APPLY" = 1 ]; then
    aws iam update-assume-role-policy --role-name "$PROD_ROLE" \
      --policy-document "file://$IAM_DIR/eng-platform-oidc-prod-deploy-trust.json"
  fi
fi

echo
echo "Repository variables to set after --apply (ARNs are not secrets):"
echo "  gh variable set AWS_STAGING_ROLE_ARN --repo exafyltd/vitana-platform --body arn:aws:iam::$EXPECTED_ACCOUNT:role/$STAGING_ROLE"
echo "  gh variable set AWS_DRIFT_ROLE_ARN   --repo exafyltd/vitana-platform --body arn:aws:iam::$EXPECTED_ACCOUNT:role/$DRIFT_ROLE"
echo "  gh variable set AWS_STAGING_ROLE_ARN --repo exafyltd/vitana-v1       --body arn:aws:iam::$EXPECTED_ACCOUNT:role/$STAGING_ROLE"
echo "  gh variable set AWS_PREVIEW_ROLE_ARN --repo exafyltd/vitana-v1       --body arn:aws:iam::$EXPECTED_ACCOUNT:role/$PREVIEW_ROLE"
echo "Then, after one green staging deploy, preview deploy and drift run on OIDC: deactivate and delete the access keys"
echo "of IAM user $STAGING_USER by hand, and run --narrow-prod-trust <prod role> --apply (plan §8)."
