#!/usr/bin/env bash
#
# VTID-04344 — delete the retired vitana-cognee-extractor ECS service.
#
# Platform-owner decision 2026-09-23 (docs/MEMORY-SYSTEM-PLAN.md §7
# decision 1): Cognee is removed with no replacement. The code is deleted in
# the same PR; this removes the AWS service left over from the 2026-07-09
# bulk-provisioning event. It was already at desiredCount=0 (checked
# 2026-09-23), so deleting it changes nothing at runtime.
#
# Claude Code sessions cannot run this — deleting infrastructure is blocked
# for them by design. Run it from an admin session.
#
# The task-definition family (vitana-cognee-extractor) is NOT deregistered
# here: registered revisions cost nothing and keep the history readable.
#
# USAGE
#   scripts/aws/retire-cognee-extractor.sh           # dry run: show state
#   scripts/aws/retire-cognee-extractor.sh --apply   # delete the service

set -euo pipefail

REGION="eu-central-1"
ACCOUNT_EXPECTED="472838866351"
CLUSTER="Vitana-ECS-Cluster"
SERVICE="vitana-cognee-extractor"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
if [ "$ACCOUNT" != "$ACCOUNT_EXPECTED" ]; then
  echo "Refusing: AWS account is $ACCOUNT, expected $ACCOUNT_EXPECTED." >&2
  exit 1
fi

STATE=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].{status:status,desired:desiredCount,running:runningCount}' --output json)
echo "Current: $STATE"

if [ "${1:-}" != "--apply" ]; then
  echo "Dry run only. Re-run with --apply to delete $SERVICE."
  exit 0
fi

aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
  --desired-count 0 >/dev/null
aws ecs delete-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
  --query 'service.{status:status}' --output table
echo "Deleted. It drains to INACTIVE within a few minutes."
