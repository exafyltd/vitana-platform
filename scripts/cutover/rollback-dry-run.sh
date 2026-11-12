#!/usr/bin/env bash
# VTID-05023 rollback path. Dry run by default: prints each step, its checks and
# its commands. Nothing is executed unless --execute is passed.
#
# Order (brief, and window-runbook.md step 7):
#   1. Switch the REST base back to Supabase (DATA_REST_BASE_MODE=supabase, agent C's setting).
#   2. Point the gateway service at the previous known-good task definition revision.
#   3. Stop the DMS sync task.
#
# Usage:
#   scripts/cutover/rollback-dry-run.sh --previous-revision <n> [--target staging]
#                                       [--verify-aws] [--execute]
#
# --verify-aws  Run read-only AWS checks (account, cluster, service, revision, DMS task).
#               Without it no AWS call is made, and each check is marked not verified.
# --execute     Run the commands. Needs --verify-aws, and every check must pass.
#               Step 1 has no command on main yet, so --execute refuses until one exists.
# The production target is refused in every mode. Only "staging" is accepted.
# The DMS task ARN is read from the DMS_TASK_ARN environment variable.
set -euo pipefail

ACCOUNT_ID=472838866351
ECS_CLUSTER=Vitana-ECS-Cluster
ECS_REGION="${AWS_REGION:-us-east-1}"
DMS_REGION="${DMS_REGION:-eu-central-1}"
GATEWAY_TASK_FAMILY="${GATEWAY_TASK_FAMILY:-vitana-gateway}"
NOT_VERIFIED='not verified: no AWS access from this sandbox'

TARGET=staging
ECS_SERVICE=vitana-gateway   # staging gateway service, see AWS-STAGE-DEPLOY-GATEWAY.yml
REV=""
EXECUTE=0
VERIFY_AWS=0
CHECKS_OK=1

die() {
  local code=$1
  shift
  echo "ERROR: $*" >&2
  exit "$code"
}

usage() {
  echo "Usage: rollback-dry-run.sh --previous-revision <n> [--target staging] [--verify-aws] [--execute]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --previous-revision)
      [[ $# -ge 2 ]] || die 2 "--previous-revision needs a value"
      REV=$2
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || die 2 "--target needs a value"
      TARGET=$2
      shift 2
      ;;
    --execute)
      EXECUTE=1
      shift
      ;;
    --verify-aws)
      VERIFY_AWS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die 2 "unknown argument: $1"
      ;;
  esac
done

if [[ "$TARGET" == production || "$TARGET" == prod ]]; then
  die 3 "refused: target '$TARGET' is not allowed in this run. Production rollback is owner-only."
fi
if [[ "$TARGET" != staging ]]; then
  die 3 "refused: target '$TARGET' is not allowed. Allowed target: staging."
fi
if [[ -z "$REV" ]]; then
  usage >&2
  die 2 "refused: --previous-revision <n> is required. No previous revision is pinned in the repo."
fi
if [[ ! "$REV" =~ ^[0-9]+$ ]]; then
  die 2 "refused: --previous-revision must be a number, got '$REV'"
fi
if (( EXECUTE )) && (( ! VERIFY_AWS )); then
  die 4 "refused: --execute needs --verify-aws so the checks run before anything is changed"
fi

# run_check <label> <expected output or "*"> <aws args...>
# Read-only. Passes when aws exits 0 and prints the expected value (or any non-empty value for "*").
run_check() {
  local label=$1 expected=$2
  shift 2
  if (( ! VERIFY_AWS )); then
    echo "  check: $label: $NOT_VERIFIED (owner to verify)"
    return 0
  fi
  local out
  if out=$(aws "$@" 2>/dev/null) && [[ -n "$out" ]] && { [[ "$expected" == "*" ]] || [[ "$out" == "$expected" ]]; }; then
    echo "  check: $label: verified ($out)"
  else
    echo "  check: $label: FAILED, aws not reachable or value not found (owner to verify; aws output: ${out:-none})"
    CHECKS_OK=0
  fi
}

ECS_SERVICE_ARG=(--cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" --region "$ECS_REGION")
S2_UPDATE=(aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE"
  --task-definition "$GATEWAY_TASK_FAMILY:$REV" --region "$ECS_REGION")
S2_WAIT=(aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" --region "$ECS_REGION")
S3_STOP=(aws dms stop-replication-task --replication-task-arn "${DMS_TASK_ARN:-NOT_SET_DMS_TASK_ARN}"
  --region "$DMS_REGION")
# Step 1 has no command on main. Owner supplies it here before any --execute run.
S1_CMD=()

show() {
  printf '  command:'
  printf ' %q' "$@"
  echo
}

echo "VTID-05023 rollback path. Target: $TARGET. Previous revision: $GATEWAY_TASK_FAMILY:$REV."
if (( EXECUTE )); then
  echo "Mode: EXECUTE (requested)."
else
  echo "Mode: dry run. Nothing is executed."
fi
echo

echo "STEP 1: switch REST base back to Supabase (DATA_REST_BASE_MODE=supabase)"
echo "  setting: DATA_REST_BASE_MODE, unset or 'supabase' means Supabase. Auth stays on Supabase in both modes."
echo "  source: agent C branch cutover/vtid-05023-C-rest-switch (local to agent C, not on origin)"
echo "  check: setting is not on main yet. $NOT_VERIFIED (owner to verify)"
if (( ${#S1_CMD[@]} == 0 )); then
  echo "  command: TODO: owner to supply. No command that sets DATA_REST_BASE_MODE on the staging gateway exists on main."
else
  show "${S1_CMD[@]}"
fi
echo

echo "STEP 2: point gateway service at previous revision $GATEWAY_TASK_FAMILY:$REV"
run_check "account is $ACCOUNT_ID (aws sts get-caller-identity)" "$ACCOUNT_ID" \
  sts get-caller-identity --query Account --output text
run_check "cluster $ECS_CLUSTER and service $ECS_SERVICE are ACTIVE" ACTIVE \
  ecs describe-services "${ECS_SERVICE_ARG[@]}" --query 'services[0].status' --output text
run_check "task definition $GATEWAY_TASK_FAMILY:$REV exists" "*" \
  ecs describe-task-definition --task-definition "$GATEWAY_TASK_FAMILY:$REV" \
  --region "$ECS_REGION" --query taskDefinition.taskDefinitionArn --output text
show "${S2_UPDATE[@]}"
show "${S2_WAIT[@]}"
echo

echo "STEP 3: stop the DMS sync task"
if [[ -z "${DMS_TASK_ARN:-}" ]]; then
  echo "  check: DMS_TASK_ARN is not set. Refused for --execute. (owner to verify)"
  CHECKS_OK=0
else
  run_check "DMS task $DMS_TASK_ARN exists" "*" \
    dms describe-replication-tasks --region "$DMS_REGION" \
    --filters "Name=replication-task-arn,Values=$DMS_TASK_ARN" \
    --query 'ReplicationTasks[0].Status' --output text
fi
show "${S3_STOP[@]}"
echo

if (( ! EXECUTE )); then
  echo "Dry run finished. Nothing was executed."
  exit 0
fi

# Execute path. Every check must pass, and step 1 must have a command, before anything runs.
if (( ! CHECKS_OK )); then
  die 4 "refused: a check failed or was not verified. Nothing was run."
fi
if (( ${#S1_CMD[@]} == 0 )); then
  die 6 "refused: step 1 has no command on main yet (owner to supply). Nothing was run."
fi
if [[ -z "${DMS_TASK_ARN:-}" ]]; then
  die 4 "refused: DMS_TASK_ARN is not set. Nothing was run."
fi
"${S1_CMD[@]}"
"${S2_UPDATE[@]}"
"${S2_WAIT[@]}"
"${S3_STOP[@]}"
echo "Executed. Steps 1, 2 and 3 ran in that order."
