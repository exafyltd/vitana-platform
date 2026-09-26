#!/usr/bin/env bash
#
# VTID-04037 — grant the gateway/executor ECS task role the read-only
# and control permissions the Operator Console tools shipped under
# VTID-04020, VTID-04032, VTID-04035 and VTID-03836 need at runtime.
#
# WHY THIS EXISTS
#
# Operator tools already ship and already fail HONESTLY without these
# grants — each returns the IAM denial verbatim to the console instead of
# pretending (verified live 2026-09-17 for logs:FilterLogEvents, VTID-04020):
#
#   dev_cloudwatch_logs   (VTID-04020)  logs:FilterLogEvents + logs:DescribeLogGroups
#                                        on /ecs/vitana-* log groups
#   dev_ecs_tasks         (VTID-04035)  ecs:ListTasks + ecs:DescribeTasks on
#                                        cluster Vitana-ECS-Cluster
#   cancel a running run  (VTID-04032)  ecs:StopTask on tasks in that cluster
#                                        (best effort — a denial is recorded on
#                                        the execution row and the agent still
#                                        stops cooperatively at its next turn)
#   dev_aws_ecs_status    (VTID-03836)  ecs:DescribeServices on services in
#                                        cluster Vitana-ECS-Cluster
#
# No Claude Code session can write IAM here: the session user
# (claude-code-aws-agent) carries a permissions boundary that explicitly
# denies iam:* on vitana-ecs-task-role (confirmed live 2026-09-18 — even
# iam:GetRole is refused with "explicit deny in a permissions boundary"), so
# the same convention as setup-fish-audio-secret.sh / setup-erp-bridge-
# staging.sh applies: this script is the exact, idempotent, least-privilege
# call an operator with IAM rights runs instead. Nothing here widens to a
# managed policy; every statement is scoped to the one cluster / log-group
# prefix the tools are already hard-limited to in code.
#
# The IaC repo (exafyltd/vitana-infra) is the long-term home for this policy;
# its README still says its checked-in state is stale vs live infra, so this
# script records the exact grant until that repo is reconciled.
#
# USAGE
#
#   scripts/aws/setup-operator-agent-task-role-grants.sh            # dry run: prints the policy
#   scripts/aws/setup-operator-agent-task-role-grants.sh --apply    # put-role-policy (idempotent)
#   scripts/aws/setup-operator-agent-task-role-grants.sh status     # show the inline policy if present
#
# Needs: iam:PutRolePolicy / iam:GetRolePolicy on the role (CloudShell as an
# admin, or any principal without the claude-code boundary).

set -euo pipefail

REGION="eu-central-1"
ACCOUNT_ID="472838866351"
ROLE_NAME="vitana-ecs-task-role"
CLUSTER_NAME="Vitana-ECS-Cluster"
POLICY_NAME="vitana-operator-agent-readonly-and-cancel-VTID-04037"
ACTION="provision"
APPLY=0

say() { echo "[setup-operator-agent-task-role-grants] $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    provision|status) ACTION="$1"; shift ;;
    --apply) APPLY=1; shift ;;
    --role) ROLE_NAME="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

CLUSTER_ARN="arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER_NAME}"

POLICY_DOC=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OperatorCloudWatchLogsReadVTID04020",
      "Effect": "Allow",
      "Action": ["logs:FilterLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"],
      "Resource": [
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/ecs/vitana-*",
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/ecs/vitana-*:*"
      ]
    },
    {
      "Sid": "OperatorEcsTasksReadVTID04035",
      "Effect": "Allow",
      "Action": ["ecs:ListTasks", "ecs:DescribeTasks"],
      "Resource": "*",
      "Condition": { "ArnEquals": { "ecs:cluster": "${CLUSTER_ARN}" } }
    },
    {
      "Sid": "DevAutopilotCancelStopTaskVTID04032",
      "Effect": "Allow",
      "Action": ["ecs:StopTask"],
      "Resource": "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task/${CLUSTER_NAME}/*",
      "Condition": { "ArnEquals": { "ecs:cluster": "${CLUSTER_ARN}" } }
    },
    {
      "Sid": "OperatorEcsServicesReadVTID03836",
      "Effect": "Allow",
      "Action": ["ecs:DescribeServices"],
      "Resource": "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:service/${CLUSTER_NAME}/*"
    }
  ]
}
JSON
)

case "$ACTION" in
  status)
    say "inline policy ${POLICY_NAME} on ${ROLE_NAME}:"
    aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" \
      --query PolicyDocument --output json 2>/dev/null || say "  (absent)"
    ;;
  provision)
    say "account $(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo '<unknown>') region ${REGION}"
    say "role ${ROLE_NAME}  policy ${POLICY_NAME}"
    echo "$POLICY_DOC" | jq .
    if [[ "$APPLY" -ne 1 ]]; then
      say "dry run — re-run with --apply to put-role-policy"
      exit 0
    fi
    aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" \
      --policy-document "$POLICY_DOC"
    say "applied. Verify from the staging Operator Console:"
    say "  dev_cloudwatch_logs service=gateway  -> events, not an AccessDenied line"
    say "  dev_ecs_tasks target=vitana-autopilot-executor desired_status=STOPPED -> stop codes"
    ;;
esac
