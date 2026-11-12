#!/usr/bin/env bash
# staging-tg-setup.sh — the staging target groups' deregistration delay to 30 seconds (plan agentic-delivery §3.6
# step 2, owner step A1; VTID-05546). Staging services then stabilise in a few minutes after a deploy.
#
# WHO RUNS IT: the owner, through scripts/aws/setup-gitlab-oidc.sh (same mode), or alone in CloudShell.
# DRY RUN BY DEFAULT: reads the load balancers of the five staging ECS services of plan §3.10 and prints every call
# exactly ("[READ] aws …", "[DRY-RUN] aws …"); --apply runs the modify calls ("[APPLY] aws …").
# STOPS unless the account is 472838866351 and the region eu-central-1. Refuses a target group whose name contains
# "prod". Changes nothing else.
#
# USAGE: scripts/eng/deploy/staging-tg-setup.sh [--apply] [--region eu-central-1] [--seconds 30]

set -euo pipefail

EXPECTED_ACCOUNT="472838866351"
EXPECTED_REGION="eu-central-1"
CLUSTER="Vitana-ECS-Cluster"
SERVICES=(vitana-gateway vitana-community-app-staging vitana-erp-bridge vitana-kiro-runner vitana-postgrest-aurora-proxy)
APPLY=0
SECONDS_WANTED=30
REGION_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --region) REGION_ARG="${2:?needs a region}"; shift 2 ;;
    --seconds) SECONDS_WANTED="${2:?needs a number}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$SECONDS_WANTED" in ''|*[!0-9]*) echo "--seconds must be a number" >&2; exit 2 ;; esac

command -v aws >/dev/null 2>&1 || { echo "aws CLI not found" >&2; exit 3; }
command -v jq >/dev/null 2>&1 || { echo "jq not found" >&2; exit 3; }

REGION="${REGION_ARG:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
if [ -z "$REGION" ]; then REGION="$(aws configure get region 2>/dev/null || true)"; fi
if [ "$REGION" != "$EXPECTED_REGION" ]; then
  echo "refusing to run: region is '${REGION:-<unset>}', expected $EXPECTED_REGION" >&2
  exit 4
fi
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
MODE="DRY-RUN"; [ "$APPLY" = 1 ] && MODE="APPLY"

exec 3>&1
read_call() { { printf '[READ]'; printf ' %q' "$@"; printf '\n'; } >&3; "$@"; }
write_call() {
  { printf '[%s]' "$MODE"; printf ' %q' "$@"; printf '\n'; } >&3
  if [ "$APPLY" = 1 ]; then "$@"; fi
}

ACCOUNT="$(read_call aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]; then
  echo "refusing to run: caller account is '${ACCOUNT:-<no credentials>}', expected $EXPECTED_ACCOUNT" >&2
  exit 4
fi

TGS="$(read_call aws ecs describe-services --cluster "$CLUSTER" --services "${SERVICES[@]}" \
  --query 'services[].loadBalancers[].targetGroupArn' --output json)"
if [ "$(jq 'length' <<<"$TGS")" = 0 ]; then echo "no staging target group found"; exit 0; fi
for tg in $(jq -r 'unique[]' <<<"$TGS"); do
  case "$tg" in *[Pp][Rr][Oo][Dd]*) echo "refusing: target group $tg looks like production" >&2; exit 7 ;; esac
  now="$(read_call aws elbv2 describe-target-group-attributes --target-group-arn "$tg" \
    --query "Attributes[?Key=='deregistration_delay.timeout_seconds'].Value | [0]" --output text)"
  if [ "$now" = "$SECONDS_WANTED" ]; then
    echo "  $tg: deregistration delay already ${now}s"
  else
    echo "  $tg: deregistration delay ${now}s -> ${SECONDS_WANTED}s"
    write_call aws elbv2 modify-target-group-attributes --target-group-arn "$tg" \
      --attributes "Key=deregistration_delay.timeout_seconds,Value=$SECONDS_WANTED"
  fi
done
