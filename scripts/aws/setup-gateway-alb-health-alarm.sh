#!/usr/bin/env bash
#
# VTID-04987 — out-of-band alarm when the gateway has NO healthy ALB targets.
#
# WHY THIS EXISTS
#
# The Command Hub Overview cockpit is the triage surface; it is served BY the
# gateway, so a dead gateway cannot report itself. This CloudWatch alarm fires
# from AWS's own load-balancer metrics and pages through the existing SNS
# topic `vitana-alarms-prod` (Plan A owner decision 8, 2026-10-04: "ALB
# target-health alarm on vitana-gateway — approved, separate infra VTID").
#
# THE ALARM
#
#   --service vitana-gateway-awsdr  (production) -> vitana-gateway-prod-no-healthy-targets
#   --service vitana-gateway        (staging)    -> vitana-gateway-staging-no-healthy-targets
#
#   Namespace AWS/ApplicationELB, metric HealthyHostCount, statistic Minimum,
#   threshold < 1, period 60 s, 2 evaluation periods (2 of 2 datapoints),
#   dimensions TargetGroup + LoadBalancer of the service's own target group,
#   TreatMissingData=breaching, AlarmActions + OKActions -> vitana-alarms-prod.
#
#   Minimum < 1 fires only when EVERY target was unhealthy for a whole minute,
#   twice in a row. A rolling deploy keeps at least one healthy target, so it
#   does not fire on a normal deploy.
#
# TreatMissingData=breaching — THE TRADE-OFF (plan C, F6)
#
#   For a production gateway, "no data" and "no healthy targets" both mean
#   "page someone": the ALB stops emitting HealthyHostCount when the target
#   group has no registered targets at all (service scaled to 0, every task
#   gone), which is exactly the outage this alarm exists for. The cost: an
#   INTENTIONAL drain (desiredCount 0, a target-group swap) also pages. That
#   is rare and the alarm description says so; silence the alarm
#   (aws cloudwatch disable-alarm-actions) for a planned drain instead of
#   weakening it to notBreaching.
#
# NAMING CONVENTION — `vitana-gateway-prod-` (read this before adding alarms)
#
#   The cockpit's cloudwatch_alarms source (ops-attention-adapters.ts,
#   GATEWAY_PROD_ALARM_PREFIX) classifies an alarm in ALARM as P1 when its
#   name starts with `vitana-gateway-prod-`, and as P2 otherwise. Every alarm
#   about the PRODUCTION gateway must use that prefix to page as P1; the
#   staging twin deliberately does not (it is P2).
#
# HOW THE RESOURCES ARE FOUND — NEVER BY TARGET-GROUP NAME
#
#   cluster -> ECS service -> loadBalancers[].targetGroupArn -> the target
#   group's LoadBalancerArns -> the ALB, read from AWS on every run
#   (CLAUDE.md ALWAYS 12). Names lie here: the target group NAMED
#   `vitana-tg-gateway-prod` serves STAGING (.claude/rules/infrastructure.md
#   §1b hard rules), so looking a target group up by name would wire the
#   production alarm to the staging gateway. This script never does.
#
#   The SNS topic is resolved by name (`vitana-alarms-prod`, the one target of
#   the existing vitana-* alarms, docs/AWS-PRODUCTION-BUILD-LOG.md); the script
#   refuses if it does not exist. It never creates a topic.
#
# USAGE
#
#   scripts/aws/setup-gateway-alb-health-alarm.sh --service vitana-gateway-awsdr            # dry run (read-only calls only)
#   scripts/aws/setup-gateway-alb-health-alarm.sh --service vitana-gateway-awsdr --apply    # put-metric-alarm (idempotent)
#   scripts/aws/setup-gateway-alb-health-alarm.sh --service vitana-gateway [--apply]        # the staging twin
#
# Dry run makes only read calls: sts get-caller-identity, ecs
# describe-services, elbv2 describe-target-groups, sns list-topics,
# cloudwatch describe-alarms. --apply adds one cloudwatch put-metric-alarm
# (create or overwrite this one alarm), then reads it back.

set -euo pipefail

REGION="eu-central-1"
ACCOUNT_ID="472838866351"
CLUSTER_NAME="Vitana-ECS-Cluster"
SNS_TOPIC_NAME="vitana-alarms-prod"
SERVICE=""
APPLY=0

say() { echo "[setup-gateway-alb-health-alarm] $*"; }
die() { echo "[setup-gateway-alb-health-alarm] ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --cluster) CLUSTER_NAME="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,72p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$SERVICE" in
  vitana-gateway-awsdr) ENV_NAME="prod";    ALARM_NAME="vitana-gateway-prod-no-healthy-targets" ;;
  vitana-gateway)       ENV_NAME="staging"; ALARM_NAME="vitana-gateway-staging-no-healthy-targets" ;;
  *) die "--service vitana-gateway-awsdr|vitana-gateway is required" ;;
esac

command -v aws >/dev/null || die "aws CLI not found"
command -v jq >/dev/null || die "jq not found"

# Account / region guard (CLAUDE.md IF-THEN 11).
CALLER_ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || die "no AWS credentials (sts get-caller-identity failed)"
[[ "$CALLER_ACCOUNT" == "$ACCOUNT_ID" ]] || die "account is ${CALLER_ACCOUNT}, expected ${ACCOUNT_ID} — STOP"
say "account ${CALLER_ACCOUNT} region ${REGION} env ${ENV_NAME} service ${SERVICE} cluster ${CLUSTER_NAME}"

# 1. ECS service -> its target group(s). Exactly one, or refuse.
SVC_JSON=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER_NAME" --services "$SERVICE" --output json)
[[ "$(echo "$SVC_JSON" | jq -r '.services | length')" == "1" ]] || die "ECS service ${SERVICE} not found in ${CLUSTER_NAME}"
mapfile -t TG_ARNS < <(echo "$SVC_JSON" | jq -r '.services[0].loadBalancers[].targetGroupArn' | sort -u)
[[ "${#TG_ARNS[@]}" -eq 1 && -n "${TG_ARNS[0]}" ]] \
  || die "expected exactly one target group on ${SERVICE}, found ${#TG_ARNS[@]}: ${TG_ARNS[*]:-none}"
TG_ARN="${TG_ARNS[0]}"

# 2. Target group (by ARN, never by name) -> its ALB. Exactly one, or refuse.
TG_JSON=$(aws elbv2 describe-target-groups --region "$REGION" --target-group-arns "$TG_ARN" --output json)
TG_NAME=$(echo "$TG_JSON" | jq -r '.TargetGroups[0].TargetGroupName')
mapfile -t LB_ARNS < <(echo "$TG_JSON" | jq -r '.TargetGroups[0].LoadBalancerArns[]')
[[ "${#LB_ARNS[@]}" -eq 1 && -n "${LB_ARNS[0]}" ]] \
  || die "expected exactly one load balancer on ${TG_ARN}, found ${#LB_ARNS[@]}"
LB_ARN="${LB_ARNS[0]}"

# CloudWatch dimension values are the ARN suffixes.
TG_DIM="${TG_ARN#*:targetgroup/}";  TG_DIM="targetgroup/${TG_DIM}"
LB_DIM="${LB_ARN#*:loadbalancer/}"
[[ "$TG_DIM" == targetgroup/*/* ]] || die "unexpected target group ARN shape: ${TG_ARN}"
[[ "$LB_DIM" == app/*/* ]] || die "unexpected (non-ALB?) load balancer ARN shape: ${LB_ARN}"

say "resolved from AWS (not from names):"
say "  target group  ${TG_ARN}  (name ${TG_NAME} — informational only)"
say "  load balancer ${LB_ARN}"
say "  dimensions    TargetGroup=${TG_DIM} LoadBalancer=${LB_DIM}"

# 3. The existing SNS topic, by name. Refuse if absent; never create one.
SNS_ARN=$(aws sns list-topics --region "$REGION" --output json \
           | jq -r --arg n "$SNS_TOPIC_NAME" '.Topics[].TopicArn | select(endswith(":" + $n))' | head -n 1)
[[ -n "$SNS_ARN" ]] || die "SNS topic ${SNS_TOPIC_NAME} not found in ${REGION} — refusing (this script never creates a topic)"
say "  SNS topic     ${SNS_ARN}"

# 4. Current state of the alarm (if any).
say "current alarm ${ALARM_NAME}:"
aws cloudwatch describe-alarms --region "$REGION" --alarm-names "$ALARM_NAME" \
  --query 'MetricAlarms[0].{state: StateValue, dimensions: Dimensions, actions: AlarmActions, missing: TreatMissingData}' \
  --output json

DESCRIPTION="VTID-04987: the ${ENV_NAME} gateway (ECS ${SERVICE}) has no healthy ALB targets (HealthyHostCount Minimum < 1 for 2 x 60 s). Missing data counts as breaching: an intentional drain also fires — disable alarm actions for a planned drain instead."

say "would put-metric-alarm:"
cat <<EOF
  --alarm-name ${ALARM_NAME}
  --namespace AWS/ApplicationELB --metric-name HealthyHostCount --statistic Minimum
  --dimensions Name=TargetGroup,Value=${TG_DIM} Name=LoadBalancer,Value=${LB_DIM}
  --period 60 --evaluation-periods 2 --datapoints-to-alarm 2
  --threshold 1 --comparison-operator LessThanThreshold
  --treat-missing-data breaching
  --alarm-actions ${SNS_ARN} --ok-actions ${SNS_ARN}
EOF

if [[ "$APPLY" -ne 1 ]]; then
  say "dry run — nothing changed. Re-run with --apply to create/update the alarm."
  exit 0
fi

aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name "$ALARM_NAME" \
  --alarm-description "$DESCRIPTION" \
  --namespace AWS/ApplicationELB \
  --metric-name HealthyHostCount \
  --statistic Minimum \
  --dimensions "Name=TargetGroup,Value=${TG_DIM}" "Name=LoadBalancer,Value=${LB_DIM}" \
  --period 60 \
  --evaluation-periods 2 \
  --datapoints-to-alarm 2 \
  --threshold 1 \
  --comparison-operator LessThanThreshold \
  --treat-missing-data breaching \
  --actions-enabled \
  --alarm-actions "$SNS_ARN" \
  --ok-actions "$SNS_ARN"
say "applied ${ALARM_NAME}. Read back:"
aws cloudwatch describe-alarms --region "$REGION" --alarm-names "$ALARM_NAME" \
  --query 'MetricAlarms[0].{name: AlarmName, state: StateValue, reason: StateReason, dimensions: Dimensions, actions: AlarmActions, missing: TreatMissingData}' \
  --output json
