#!/usr/bin/env bash
# VTID-05782 (plan autonomous-to-staging-r2 §3.3, lane staging-db-provision; design.md §2, §4, §6): create the isolated
# staging Aurora cluster `vitana-aurora-staging` — Aurora PostgreSQL 16 Serverless v2, one writer, the stack's own KMS
# key, subnet group and security group, RDS-managed master password, Data API on, backup retention 1 day, deletion
# protection on, tag vitana-env=staging. Never a production resource, never a copy of production data.
#
# Usage:
#   staging-db-provision.sh --plan  --cluster vitana-aurora-staging [--min-acu 0] [--max-acu 2] [--auto-pause 300] [--engine-version 16.4]
#   staging-db-provision.sh --apply --cluster vitana-aurora-staging [--stack vitana-staging-db] [--engine-version 16.4]
#
# --plan makes NO AWS call: it prints the calls --apply would make (values that only the stack knows are shown as
#        <StackOutput>; capacity from the flags, default option A: min 0 ACU, auto-pause 300 s, max 2 ACU).
# --apply needs STAGING_DB_COST_APPROVED=yes (the owner's cost approval, design.md §6.1) and credentials of the stack
#        role vitana-gha-staging-db in account 472838866351 / eu-central-1. It reads the KMS key, subnet group, security
#        group and capacity from the outputs of the owner-applied stack, creates the cluster and its writer if they do
#        not exist yet (an existing cluster is left as it is and only reported), and enables the Data API.
# Exit: 0 ok; 1 refused or failed; 2 usage.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=staging-db-common.sh
. "$HERE/staging-db-common.sh"

MODE=""; CLUSTER=""; STACK="$SDB_STACK_DEFAULT"; ENGINE_VERSION="16.4"
MIN_ACU=""; MAX_ACU=""; AUTO_PAUSE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) MODE=plan; shift ;;
    --apply) MODE=apply; shift ;;
    --cluster) CLUSTER="${2:-}"; shift 2 ;;
    --stack) STACK="${2:-}"; shift 2 ;;
    --engine-version) ENGINE_VERSION="${2:-}"; shift 2 ;;
    --min-acu) MIN_ACU="${2:-}"; shift 2 ;;
    --max-acu) MAX_ACU="${2:-}"; shift 2 ;;
    --auto-pause) AUTO_PAUSE="${2:-}"; shift 2 ;;
    *) sdb_usage "unknown argument: $1" ;;
  esac
done
[ -n "$MODE" ] || sdb_usage "usage: $0 --plan|--apply --cluster vitana-aurora-staging"
sdb_check_cluster "$CLUSTER"
printf '%s' "$STACK" | grep -Eq '^vitana-staging-db[a-z0-9-]*$' || sdb_die "refused: stack '$STACK' is not the staging database stack"
# Aurora PostgreSQL 16.3 or later (min 0 ACU / auto-pause needs >= 16.3).
printf '%s' "$ENGINE_VERSION" | grep -Eq '^16\.([3-9]|[1-9][0-9])$' || sdb_die "refused: engine version '$ENGINE_VERSION' (expected Aurora PostgreSQL 16.3 or later 16.x)"

check_capacity() {
  printf '%s' "$MIN_ACU" | grep -Eq '^(0|0\.5)$' || sdb_die "refused: --min-acu '$MIN_ACU' (0 = auto-pause, option A; 0.5 = option B)"
  printf '%s' "$MAX_ACU" | grep -Eq '^(1|1\.5|2)(\.0)?$' || sdb_die "refused: --max-acu '$MAX_ACU' (1..2; 2 ACU is the cost cap)"
  printf '%s' "$AUTO_PAUSE" | grep -Eq '^[0-9]+$' && [ "$AUTO_PAUSE" -ge 300 ] && [ "$AUTO_PAUSE" -le 86400 ] || sdb_die "refused: --auto-pause '$AUTO_PAUSE' (300..86400 s)"
}

INSTANCE="${CLUSTER}-writer"
TAGS=(Key=vitana-env,Value=staging Key=vitana-vtid,Value=VTID-05782 Key=vitana-stack,Value="$STACK")

scaling() {
  if [ "$MIN_ACU" = "0" ]; then echo "MinCapacity=$MIN_ACU,MaxCapacity=$MAX_ACU,SecondsUntilAutoPause=$AUTO_PAUSE"
  else echo "MinCapacity=$MIN_ACU,MaxCapacity=$MAX_ACU"; fi
}

create_cluster_args() { # <kms> <subnet group> <sg>
  echo rds create-db-cluster --region "$SDB_REGION" \
    --db-cluster-identifier "$CLUSTER" --engine aurora-postgresql --engine-version "$ENGINE_VERSION" \
    --database-name vitana --master-username vitana_admin \
    --manage-master-user-password --master-user-secret-kms-key-id "$1" \
    --storage-encrypted --kms-key-id "$1" \
    --db-subnet-group-name "$2" --vpc-security-group-ids "$3" \
    --serverless-v2-scaling-configuration "$(scaling)" \
    --backup-retention-period 1 --deletion-protection --copy-tags-to-snapshot \
    --tags "${TAGS[@]}"
}
create_instance_args() {
  echo rds create-db-instance --region "$SDB_REGION" \
    --db-instance-identifier "$INSTANCE" --db-cluster-identifier "$CLUSTER" \
    --engine aurora-postgresql --db-instance-class db.serverless --no-publicly-accessible \
    --tags "${TAGS[@]}"
}

if [ "$MODE" = "plan" ]; then
  MIN_ACU="${MIN_ACU:-0}"; MAX_ACU="${MAX_ACU:-2}"; AUTO_PAUSE="${AUTO_PAUSE:-300}"
  check_capacity
  echo "Plan for $CLUSTER (no AWS call made). --apply would run, in account $SDB_ACCOUNT / $SDB_REGION:"
  echo "  aws sts get-caller-identity                       (account check)"
  echo "  aws cloudformation describe-stacks --stack-name $STACK   (KmsKeyArn, DbSubnetGroupName, DbSecurityGroupId, MinAcu, MaxAcu, SecondsUntilAutoPause)"
  echo "  aws rds describe-db-clusters --db-cluster-identifier $CLUSTER   (exists? then nothing is created)"
  echo "  aws $(create_cluster_args '<StackOutput:KmsKeyArn>' '<StackOutput:DbSubnetGroupName>' '<StackOutput:DbSecurityGroupId>')"
  echo "  aws rds wait db-cluster-available --db-cluster-identifier $CLUSTER"
  echo "  aws $(create_instance_args)"
  echo "  aws rds wait db-instance-available --db-instance-identifier $INSTANCE"
  echo "  aws rds enable-http-endpoint --resource-arn $(sdb_cluster_arn "$CLUSTER")"
  echo "Capacity: min $MIN_ACU ACU, max $MAX_ACU ACU$( [ "$MIN_ACU" = 0 ] && echo ", auto-pause after $AUTO_PAUSE s"); engine aurora-postgresql $ENGINE_VERSION; backup retention 1 day; deletion protection on."
  echo "Cost (design.md §2, list prices eu-central-1): option A about 10-45 USD a month, option B about 56-62 USD; at most about 210 USD a month at 2 ACU."
  exit 0
fi

# --- apply ------------------------------------------------------------------------------------------------------------
[ "${STAGING_DB_COST_APPROVED:-}" = "yes" ] || sdb_die "refused: STAGING_DB_COST_APPROVED is not 'yes' (owner cost approval, design.md §6.1)"
sdb_check_account

OUT_JSON=$(aws cloudformation describe-stacks --region "$SDB_REGION" --stack-name "$STACK" --output json) \
  || sdb_die "stack $STACK not found: the owner applies infra/staging-db/stack.yaml first (design.md §6.2)"
out() { printf '%s' "$OUT_JSON" | jq -r --arg k "$1" '.Stacks[0].Outputs[]? | select(.OutputKey == $k) | .OutputValue' | head -1; }
KMS=$(out KmsKeyArn); SUBNETS=$(out DbSubnetGroupName); SG=$(out DbSecurityGroupId)
MIN_ACU="${MIN_ACU:-$(out MinAcu)}"; MAX_ACU="${MAX_ACU:-$(out MaxAcu)}"; AUTO_PAUSE="${AUTO_PAUSE:-$(out SecondsUntilAutoPause)}"
case "$KMS" in "arn:aws:kms:$SDB_REGION:$SDB_ACCOUNT:key/"*) ;; *) sdb_die "stack output KmsKeyArn '$KMS' is not a key of $SDB_ACCOUNT" ;; esac
[ "$SUBNETS" = "vitana-aurora-staging" ] || sdb_die "stack output DbSubnetGroupName '$SUBNETS' is not vitana-aurora-staging"
printf '%s' "$SG" | grep -Eq '^sg-[0-9a-f]+$' || sdb_die "stack output DbSecurityGroupId '$SG' is not a security group id"
check_capacity

if aws rds describe-db-clusters --region "$SDB_REGION" --db-cluster-identifier "$CLUSTER" --output json > /dev/null 2>&1; then
  echo "Cluster $CLUSTER exists already: nothing is created or changed."
else
  echo "Creating $CLUSTER (min $MIN_ACU ACU, max $MAX_ACU ACU)"
  # shellcheck disable=SC2046
  aws $(create_cluster_args "$KMS" "$SUBNETS" "$SG") --output json > /dev/null
  aws rds wait db-cluster-available --region "$SDB_REGION" --db-cluster-identifier "$CLUSTER"
fi
if aws rds describe-db-instances --region "$SDB_REGION" --db-instance-identifier "$INSTANCE" --output json > /dev/null 2>&1; then
  echo "Writer $INSTANCE exists already."
else
  echo "Creating writer $INSTANCE"
  # shellcheck disable=SC2046
  aws $(create_instance_args) --output json > /dev/null
  aws rds wait db-instance-available --region "$SDB_REGION" --db-instance-identifier "$INSTANCE"
fi
aws rds enable-http-endpoint --region "$SDB_REGION" --resource-arn "$(sdb_cluster_arn "$CLUSTER")" --output json > /dev/null
echo "Done: $CLUSTER available, Data API enabled. Next: AWS-STAGE-PROVISION-DB.yml mode=load with the STAGING-DB-SCHEMA bundle."
