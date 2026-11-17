#!/usr/bin/env bash
# Refuses a preview-api task definition that enables a background worker or
# binds a production-only secret or env name. Used by AWS-STAGE-DEPLOY-GATEWAY.yml
# (deploy_profile=preview-api) and kept out of the workflow text on purpose.
# Usage: preview-api-refuse-workers.sh <task-definition.json>
set -euo pipefail
TD="$1"
WORKER_FLAGS="REMINDERS_INPROCESS_DISPATCH_ENABLED REMINDERS_STAGING_DISPATCH_OVERRIDE AUTOPILOT_HEARTBEAT_ENABLED AUTOPILOT_LOOP_ENABLED CALENDAR_GOOGLE_SYNC_ENABLED CALENDAR_MAINTENANCE_ENABLED CALENDAR_DEFAULT_REMINDERS_ENABLED FEEDBACK_AUTO_DISPATCH_ENABLED DEV_AUTOPILOT_WATCHER_LIVE DEV_AUTOPILOT_USE_JOB DEV_AUTOPILOT_EXECUTOR_ENABLED DEV_AUTOPILOT_WATCHERS_ENABLED OPERATOR_PLANNER_ENABLED VTID_ALLOCATOR_ENABLED OPERATOR_VTID_SELF_ALLOCATE_ENABLED PM_AGENT_ENABLED REWARD_SWEEP_ENABLED AUTOPILOT_ACTION_REWARD_ENABLED SELF_HEALING_RECONCILER_ENABLED RECOMMENDATION_SCHEDULER_ENABLED CONNECTED_APPS_SYNC_ENABLED"
for f in $WORKER_FLAGS; do
  v=$(jq -r --arg n "$f" '[.containerDefinitions[].environment[]? | select(.name == $n) | .value] | last // "false"' "$TD")
  if [ "$v" = "true" ]; then echo "::error::refusing preview roll: worker flag $f=true"; exit 1; fi
done
BAD=$(jq -r '[.containerDefinitions[] | ((.environment // [])[], (.secrets // [])[]) | .name | select(test("^(GITHUB_SAFE_MERGE_TOKEN|GITHUB_TOKEN|ERP_BRIDGE_TOKEN|KIRO_RUNNER_TOKEN|DAILY_API_KEY|TYPESAFE_API_KEY|FISH_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_GEMINI_API_KEY|OPERATOR_MACHINE_AUTH_TOKEN|DEV_MEMORY_PACK_TOKEN|DEV_AUTOPILOT_SCAN_TOKEN|GCP_SERVICE_ACCOUNT_JSON)$|^AURORA_")) ] | unique | join(" ")' "$TD")
if [ -n "$BAD" ]; then echo "::error::refusing preview roll: production-only names bound: $BAD"; exit 1; fi
echo "preview-api guard: no worker flag true, no production-only name bound"
