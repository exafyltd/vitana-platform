#!/usr/bin/env bash
# VTID-05328 (ci-ecr-public-auth): read-only check of what the deploy builds need from IAM to log in to
# ECR Public (`aws ecr-public get-login-password --region us-east-1`): ecr-public:GetAuthorizationToken and
# sts:GetServiceBearerToken (for sts:AWSServiceName = ecr-public.amazonaws.com).
# Run in CloudShell as an IAM admin. It only calls sts:GetCallerIdentity and iam:SimulatePrincipalPolicy;
# nothing is changed. For each principal it prints the actions that are not allowed yet and the exact command
# that attaches scripts/aws/iam/ci-ecr-public-pull-policy.json. It never runs that command itself.
# Usage: bash ci-ecr-public-pull-iam-check.sh [<staging-user-name>] [<prod-deploy-role-name>]
#   staging user: the IAM user behind AWS_STAGING_ACCESS_KEY_ID (default claude-staging-validation)
#   prod role:    the OIDC role behind AWS_PROD_ROLE_ARN        (default vitana-gateway-awsdr-deploy-role)
set -euo pipefail
STAGING_USER="${1:-claude-staging-validation}"
PROD_ROLE="${2:-vitana-gateway-awsdr-deploy-role}"
DIR="$(cd "$(dirname "$0")" && pwd)"
POLICY="$DIR/ci-ecr-public-pull-policy.json"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCOUNT" = "472838866351" ] || { echo "refusing: account $ACCOUNT is not 472838866351" >&2; exit 1; }

simulate() { # principal-arn action [context-entries...]
  local arn="$1" action="$2"; shift 2
  aws iam simulate-principal-policy --policy-source-arn "$arn" --action-names "$action" --resource-arns '*' "$@" \
    --query 'EvaluationResults[0].EvalDecision' --output text 2>/dev/null || echo error
}

check() { # kind(user|role) name
  local kind="$1" name="$2" missing=0 arn="arn:aws:iam::$ACCOUNT:$1/$2" d
  echo "== $kind $name"
  d=$(simulate "$arn" ecr-public:GetAuthorizationToken)
  if [ "$d" != "allowed" ]; then missing=$((missing + 1)); echo "  MISSING  ecr-public:GetAuthorizationToken ($d)"; fi
  d=$(simulate "$arn" sts:GetServiceBearerToken \
    --context-entries "ContextKeyName=sts:AWSServiceName,ContextKeyValues=ecr-public.amazonaws.com,ContextKeyType=string")
  if [ "$d" != "allowed" ]; then missing=$((missing + 1)); echo "  MISSING  sts:GetServiceBearerToken ($d)"; fi
  if [ "$missing" -eq 0 ]; then
    echo "  ok: both actions allowed, nothing to apply"
  else
    echo "  $missing of 2 actions not allowed yet. To apply (IAM write, run it yourself):"
    echo "    aws iam put-$kind-policy --$kind-name $name --policy-name ci-ecr-public-pull --policy-document file://$POLICY"
  fi
}

check user "$STAGING_USER"
check role "$PROD_ROLE"
