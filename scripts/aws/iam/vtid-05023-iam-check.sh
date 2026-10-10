#!/usr/bin/env bash
# VTID-05023: read-only check of what the cutover workflows need from IAM.
# Run in CloudShell as an admin. It only calls iam:SimulatePrincipalPolicy and
# sts:GetCallerIdentity — nothing is changed. For each statement of
#   scripts/aws/iam/vtid-05023-deploy-role-policy.json          (GitHub OIDC deploy role)
#   scripts/aws/iam/vtid-05023-task-execution-role-policy.json  (ECS task execution role)
# it simulates every action against the statement's resources and prints the
# ones the role does NOT have yet. Attach the policy file (or just the missing
# lines) with:
#   aws iam put-role-policy --role-name <role> --policy-name vtid-05023-cutover \
#     --policy-document file://scripts/aws/iam/<file>.json
# Usage: bash vtid-05023-iam-check.sh <deploy-role-name> [<execution-role-name>]
#   (the deploy role is the one behind the AWS_PROD_ROLE_ARN repo secret;
#    the execution role defaults to vitana-ecs-task-execution-role)
set -euo pipefail
DEPLOY_ROLE="${1:?usage: $0 <deploy-role-name> [<execution-role-name>]}"
EXEC_ROLE="${2:-vitana-ecs-task-execution-role}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCOUNT" = "472838866351" ] || { echo "refusing: account $ACCOUNT is not 472838866351" >&2; exit 1; }

check() { # role-name policy-file
  local role_arn="arn:aws:iam::$ACCOUNT:role/$1" file="$2" missing=0 total=0
  echo "== $1  ($(basename "$file"))"
  while IFS=$'\t' read -r sid action resource; do
    total=$((total + 1))
    decision=$(aws iam simulate-principal-policy --policy-source-arn "$role_arn" \
      --action-names "$action" --resource-arns "$resource" \
      --query 'EvaluationResults[0].EvalDecision' --output text 2>/dev/null || echo error)
    if [ "$decision" != "allowed" ]; then
      missing=$((missing + 1)); printf '  MISSING  %-28s %-45s %s (%s)\n' "$sid" "$action" "$resource" "$decision"
    fi
  done < <(python3 - "$file" <<'PY'
import json, sys
for s in json.load(open(sys.argv[1]))["Statement"]:
    acts = s["Action"] if isinstance(s["Action"], list) else [s["Action"]]
    res = s["Resource"] if isinstance(s["Resource"], list) else [s["Resource"]]
    for a in acts:
        for r in res:
            print(f'{s.get("Sid", "-")}\t{a}\t{r.replace("*", "x") if r != "*" else r}')
PY
)
  echo "  $missing of $total action/resource pairs not allowed yet"
  echo "  (conditions such as iam:PassedToService are not simulated; a MISSING line on a conditioned statement may still need checking by hand)"
}
check "$DEPLOY_ROLE" "$DIR/vtid-05023-deploy-role-policy.json"
check "$EXEC_ROLE" "$DIR/vtid-05023-task-execution-role-policy.json"
