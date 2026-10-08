#!/usr/bin/env bash
#
# VTID-04987 — grant the gateway ECS task role cloudwatch:DescribeAlarms, the
# one permission the Command Hub Overview's `cloudwatch_alarms` source needs
# (services/gateway/src/services/ops-attention-cloudwatch.ts).
#
# WHY THIS EXISTS
#
# The cockpit (GET /api/v1/ops/attention) reads CloudWatch alarms that are in
# ALARM state, read-only, behind OPS_ATTENTION_CLOUDWATCH_ENABLED=true. Without
# this grant the read fails with AccessDenied and the source reads UNKNOWN —
# honest, never green — so the order is: grant first, verify, then flip the
# flag (CLAUDE.md IF-THEN 31 ordering).
#
# WHAT IT GRANTS
#
# One inline policy, one statement: cloudwatch:DescribeAlarms, Resource "*".
# DescribeAlarms supports no resource-level scoping (the IAM service
# authorization reference lists no resource type for it), so "*" is the only
# form that works; the action itself is read-only. Nothing else — no
# GetMetricData, no PutMetricAlarm, no SetAlarmState.
#
# HOW THE ROLE IS FOUND
#
# Never hardcoded: cluster -> ECS service -> its live task definition ->
# taskRoleArn, read from AWS on every run (CLAUDE.md ALWAYS 12/16).
#   --env prod     -> ECS service vitana-gateway-awsdr
#   --env staging  -> ECS service vitana-gateway
# (both in cluster Vitana-ECS-Cluster, .claude/rules/infrastructure.md §1b).
# The two may resolve to the same role; the script says so, and granting one
# then grants both.
#
# No Claude Code session can write IAM here (the session user's permissions
# boundary denies iam:* on the task role), so an operator with IAM rights runs
# --apply — the same convention as setup-operator-agent-task-role-grants.sh.
#
# USAGE
#
#   scripts/aws/setup-gateway-cloudwatch-read-grant.sh --env staging            # dry run (read-only calls only)
#   scripts/aws/setup-gateway-cloudwatch-read-grant.sh --env staging --apply    # put-role-policy (idempotent), then verify
#   scripts/aws/setup-gateway-cloudwatch-read-grant.sh --env prod [--apply]
#
# Dry run makes only read calls: sts get-caller-identity, ecs
# describe-services, ecs describe-task-definition, iam get-role-policy (may be
# denied by a permissions boundary; reported, not fatal).
# --apply adds: iam put-role-policy, then the read-only verification
# (iam simulate-principal-policy for the role, and one cloudwatch
# describe-alarms --state-value ALARM call as the operator).
#
# Needs for --apply: iam:PutRolePolicy (+ iam:SimulatePrincipalPolicy,
# cloudwatch:DescribeAlarms for the verification).

set -euo pipefail

REGION="eu-central-1"
ACCOUNT_ID="472838866351"
CLUSTER_NAME="Vitana-ECS-Cluster"
POLICY_NAME="vitana-gateway-cloudwatch-describe-alarms-VTID-04987"
ENV_NAME=""
APPLY=0

say() { echo "[setup-gateway-cloudwatch-read-grant] $*"; }
die() { echo "[setup-gateway-cloudwatch-read-grant] ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --cluster) CLUSTER_NAME="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,52p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$ENV_NAME" in
  prod)    SERVICE="vitana-gateway-awsdr"; OTHER_ENV="staging"; OTHER_SERVICE="vitana-gateway" ;;
  staging) SERVICE="vitana-gateway"; OTHER_ENV="prod"; OTHER_SERVICE="vitana-gateway-awsdr" ;;
  *) die "--env staging|prod is required" ;;
esac

command -v aws >/dev/null || die "aws CLI not found"
command -v jq >/dev/null || die "jq not found"

# Account / region guard (CLAUDE.md IF-THEN 11).
CALLER_ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || die "no AWS credentials (sts get-caller-identity failed)"
[[ "$CALLER_ACCOUNT" == "$ACCOUNT_ID" ]] || die "account is ${CALLER_ACCOUNT}, expected ${ACCOUNT_ID} — STOP"
say "account ${CALLER_ACCOUNT} region ${REGION} env ${ENV_NAME} service ${SERVICE} cluster ${CLUSTER_NAME}"

# cluster -> service -> live task definition -> task role.
task_role_of() {
  local svc="$1" td role
  td=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER_NAME" --services "$svc" \
        --query 'services[0].taskDefinition' --output text) || return 1
  [[ -n "$td" && "$td" != "None" ]] || return 1
  role=$(aws ecs describe-task-definition --region "$REGION" --task-definition "$td" \
          --query 'taskDefinition.taskRoleArn' --output text) || return 1
  [[ -n "$role" && "$role" != "None" ]] || return 1
  echo "${td}|${role}"
}

RESOLVED=$(task_role_of "$SERVICE") || die "could not resolve the task role of ECS service ${SERVICE} in ${CLUSTER_NAME}"
TASK_DEF_ARN="${RESOLVED%%|*}"
ROLE_ARN="${RESOLVED##*|}"
ROLE_NAME="${ROLE_ARN##*/}"
say "live task definition: ${TASK_DEF_ARN}"
say "task role:            ${ROLE_ARN} (role name ${ROLE_NAME})"

if OTHER=$(task_role_of "$OTHER_SERVICE" 2>/dev/null); then
  OTHER_ROLE_ARN="${OTHER##*|}"
  if [[ "$OTHER_ROLE_ARN" == "$ROLE_ARN" ]]; then
    say "NOTE: ${OTHER_ENV} (${OTHER_SERVICE}) uses the SAME task role — this grant applies to both gateways."
  else
    say "${OTHER_ENV} (${OTHER_SERVICE}) uses a different task role (${OTHER_ROLE_ARN}); it needs its own run."
  fi
fi

POLICY_DOC=$(cat <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OpsAttentionCloudWatchDescribeAlarmsVTID04987",
      "Effect": "Allow",
      "Action": ["cloudwatch:DescribeAlarms"],
      "Resource": "*"
    }
  ]
}
JSON
)

say "inline policy ${POLICY_NAME} on ${ROLE_NAME}:"
echo "$POLICY_DOC" | jq .

say "current state of ${POLICY_NAME}:"
if CURRENT=$(aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" \
              --query PolicyDocument --output json 2>&1); then
  echo "$CURRENT" | jq .
else
  say "  not readable or absent: $(echo "$CURRENT" | tail -n 1)"
fi

if [[ "$APPLY" -ne 1 ]]; then
  say "dry run — nothing changed. Re-run with --apply to put-role-policy."
  exit 0
fi

aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" \
  --policy-document "$POLICY_DOC"
say "applied ${POLICY_NAME} to ${ROLE_NAME}."

# Verify, read-only. IAM is eventually consistent: a fresh grant can take a few
# seconds to show up in the simulator.
say "verify 1/2: iam simulate-principal-policy for the task role (read-only)"
DECISION="unknown"
for _ in 1 2 3 4 5 6; do
  DECISION=$(aws iam simulate-principal-policy --policy-source-arn "$ROLE_ARN" \
              --action-names cloudwatch:DescribeAlarms \
              --query 'EvaluationResults[0].EvalDecision' --output text 2>&1) || true
  [[ "$DECISION" == "allowed" ]] && break
  sleep 5
done
say "  cloudwatch:DescribeAlarms for ${ROLE_NAME}: ${DECISION}"

say "verify 2/2: one read-only DescribeAlarms (StateValue=ALARM) call, as the operator running this script"
aws cloudwatch describe-alarms --region "$REGION" --state-value ALARM --max-records 100 \
  --query '{metric_alarms_in_alarm: MetricAlarms[].AlarmName, composite_alarms_in_alarm: CompositeAlarms[].AlarmName}' \
  --output json

[[ "$DECISION" == "allowed" ]] || die "the simulator does not report the grant as allowed yet (${DECISION}); re-run in a minute"
say "done. With OPS_ATTENTION_CLOUDWATCH_ENABLED=true on ${ENV_NAME}, the cockpit's cloudwatch_alarms source should read ok."
