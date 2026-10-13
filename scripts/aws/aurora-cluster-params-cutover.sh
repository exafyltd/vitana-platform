#!/usr/bin/env bash
# VTID-05023 part 6 (+ sparring R3) — cluster parameters Aurora needs before the cutover:
#   shared_preload_libraries  += pg_cron   (existing entries preserved)
#   cron.database_name         = vitana     (pg_cron lives in the app database)
#   rds.logical_replication    = 1          (part 8b reverse CDC; owner-approved reboot)
# plus two CloudWatch alarms for the replication slot that logical replication creates
# (R3): OldestReplicationSlotLag and TransactionLogsDiskUsage on the writer.
#
# DRY RUN BY DEFAULT: prints every AWS call it would make and changes nothing.
#   scripts/aws/aurora-cluster-params-cutover.sh            # dry run
#   scripts/aws/aurora-cluster-params-cutover.sh --apply    # make the changes
#
# All three parameters are STATIC: they take effect only after a reboot of the cluster's
# instances. This script NEVER reboots — it prints the reboot commands for the window.
# If the cluster still uses a default.* parameter group (which cannot be modified), a
# custom group is created as a copy of it (same family and values) and attached; that
# attachment also only takes effect at the reboot, which is printed loudly.
#
# After the reboot: CREATE EXTENSION pg_cron is the first line of
# scripts/aws/aurora-cutover-cron.sql (run with scripts/aws/aurora-run-sql.sh).
#
# Env overrides: CLUSTER_ID (vitana-aurora-prod), CUSTOM_GROUP (vitana-aurora-prod-cluster-params),
# ALARM_TOPIC (arn:aws:sns:eu-central-1:472838866351:vitana-alarms-prod),
# SLOT_LAG_BYTES (5 GiB), TXLOG_BYTES (10 GiB).
set -euo pipefail
export AWS_PAGER=""

REGION=eu-central-1
ACCOUNT=472838866351
CLUSTER_ID="${CLUSTER_ID:-vitana-aurora-prod}"
CUSTOM_GROUP="${CUSTOM_GROUP:-vitana-aurora-prod-cluster-params}"
ALARM_TOPIC="${ALARM_TOPIC:-arn:aws:sns:eu-central-1:472838866351:vitana-alarms-prod}"
SLOT_LAG_BYTES="${SLOT_LAG_BYTES:-5368709120}"
TXLOG_BYTES="${TXLOG_BYTES:-10737418240}"

APPLY=false
case "${1:-}" in
  "") ;;
  --apply) APPLY=true ;;
  *) echo "Usage: $0 [--apply]" >&2; exit 2 ;;
esac

# run: print, and execute only with --apply. Read-only describe calls use aws directly.
run() {
  printf '+ %q' "$@"; printf '\n'
  if $APPLY; then "$@"; fi
}

# ── Account / region guard ──────────────────────────────────────────────
ACTUAL_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
if [ "$ACTUAL_ACCOUNT" != "$ACCOUNT" ]; then
  echo "ERROR: credentials are for account $ACTUAL_ACCOUNT, expected $ACCOUNT. Stop." >&2; exit 1
fi
if [ -n "${AWS_REGION:-}" ] && [ "$AWS_REGION" != "$REGION" ]; then
  echo "ERROR: AWS_REGION=$AWS_REGION, expected $REGION. Stop." >&2; exit 1
fi
echo "Account $ACCOUNT / $REGION — cluster $CLUSTER_ID — $($APPLY && echo APPLY || echo 'DRY RUN (pass --apply to change anything)')"

# ── Resolve the cluster parameter group ─────────────────────────────────
CURRENT_GROUP=$(aws rds describe-db-clusters --region "$REGION" --db-cluster-identifier "$CLUSTER_ID" \
  --query 'DBClusters[0].DBClusterParameterGroup' --output text)
FAMILY=$(aws rds describe-db-cluster-parameter-groups --region "$REGION" \
  --db-cluster-parameter-group-name "$CURRENT_GROUP" \
  --query 'DBClusterParameterGroups[0].DBParameterGroupFamily' --output text)
WRITER=$(aws rds describe-db-clusters --region "$REGION" --db-cluster-identifier "$CLUSTER_ID" \
  --query 'DBClusters[0].DBClusterMembers[?IsClusterWriter==`true`].DBInstanceIdentifier | [0]' --output text)
MEMBERS=$(aws rds describe-db-clusters --region "$REGION" --db-cluster-identifier "$CLUSTER_ID" \
  --query 'DBClusters[0].DBClusterMembers[].DBInstanceIdentifier' --output text)
echo "Current cluster parameter group: $CURRENT_GROUP (family $FAMILY); writer $WRITER; members: $MEMBERS"

GROUP="$CURRENT_GROUP"
NEEDS_ATTACH=false
if [[ "$CURRENT_GROUP" == default.* ]]; then
  GROUP="$CUSTOM_GROUP"
  NEEDS_ATTACH=true
  echo
  echo "################################################################################"
  echo "# $CLUSTER_ID uses the DEFAULT group $CURRENT_GROUP, which cannot be modified."
  echo "# A custom group $GROUP (family $FAMILY) is created as a copy and ATTACHED."
  echo "# The attachment takes effect only after the instances are REBOOTED (below)."
  echo "################################################################################"
  if aws rds describe-db-cluster-parameter-groups --region "$REGION" \
       --db-cluster-parameter-group-name "$GROUP" >/dev/null 2>&1; then
    echo "Custom group $GROUP already exists — reusing it."
  else
    run aws rds copy-db-cluster-parameter-group --region "$REGION" \
      --source-db-cluster-parameter-group-identifier "$CURRENT_GROUP" \
      --target-db-cluster-parameter-group-identifier "$GROUP" \
      --target-db-cluster-parameter-group-description "VTID-05023 vitana-aurora-prod: pg_cron + logical replication (copy of $CURRENT_GROUP)"
  fi
fi

# ── shared_preload_libraries: keep every existing entry, add pg_cron once ──
# Read from the group we will modify (the copy has the default's values); in a dry run
# where the copy does not exist yet, read the source group.
READ_GROUP="$GROUP"
aws rds describe-db-cluster-parameter-groups --region "$REGION" \
  --db-cluster-parameter-group-name "$GROUP" >/dev/null 2>&1 || READ_GROUP="$CURRENT_GROUP"
EXISTING=$(aws rds describe-db-cluster-parameters --region "$REGION" \
  --db-cluster-parameter-group-name "$READ_GROUP" \
  --query "Parameters[?ParameterName=='shared_preload_libraries'].ParameterValue | [0]" --output text)
[ "$EXISTING" = "None" ] && EXISTING=""
LIBS=$(printf '%s' "$EXISTING" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$' || true)
if ! printf '%s\n' "$LIBS" | grep -qx 'pg_cron'; then
  LIBS=$(printf '%s\n%s' "$LIBS" pg_cron | grep -v '^$')
fi
NEW_LIBS=$(printf '%s\n' "$LIBS" | paste -sd, -)
echo "shared_preload_libraries: '${EXISTING}' -> '${NEW_LIBS}'"

PARAMS_FILE=$(mktemp)
trap 'rm -f "$PARAMS_FILE"' EXIT
cat > "$PARAMS_FILE" <<JSON
[
  {"ParameterName": "shared_preload_libraries", "ParameterValue": "${NEW_LIBS}", "ApplyMethod": "pending-reboot"},
  {"ParameterName": "cron.database_name", "ParameterValue": "vitana", "ApplyMethod": "pending-reboot"},
  {"ParameterName": "rds.logical_replication", "ParameterValue": "1", "ApplyMethod": "pending-reboot"}
]
JSON
echo "Parameters to set on $GROUP:"; cat "$PARAMS_FILE"
run aws rds modify-db-cluster-parameter-group --region "$REGION" \
  --db-cluster-parameter-group-name "$GROUP" --parameters "file://$PARAMS_FILE"

if $NEEDS_ATTACH; then
  run aws rds modify-db-cluster --region "$REGION" --db-cluster-identifier "$CLUSTER_ID" \
    --db-cluster-parameter-group-name "$GROUP" --apply-immediately
fi

# ── R3: replication-slot alarms on the writer ───────────────────────────
run aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name "vitana-aurora-prod-replication-slot-lag" \
  --alarm-description "VTID-05023 R3: oldest logical replication slot is more than ${SLOT_LAG_BYTES} bytes behind (reverse CDC stalled; WAL is being retained)" \
  --namespace AWS/RDS --metric-name OldestReplicationSlotLag \
  --dimensions "Name=DBInstanceIdentifier,Value=$WRITER" \
  --statistic Maximum --period 300 --evaluation-periods 3 \
  --threshold "$SLOT_LAG_BYTES" --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching --alarm-actions "$ALARM_TOPIC" --ok-actions "$ALARM_TOPIC"
run aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name "vitana-aurora-prod-transaction-logs-disk" \
  --alarm-description "VTID-05023 R3: transaction logs (WAL held by replication slots) use more than ${TXLOG_BYTES} bytes" \
  --namespace AWS/RDS --metric-name TransactionLogsDiskUsage \
  --dimensions "Name=DBInstanceIdentifier,Value=$WRITER" \
  --statistic Maximum --period 300 --evaluation-periods 3 \
  --threshold "$TXLOG_BYTES" --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching --alarm-actions "$ALARM_TOPIC" --ok-actions "$ALARM_TOPIC"

# ── Reboot: printed, never run ──────────────────────────────────────────
echo
echo "================================================================================"
echo "REBOOT REQUIRED (static parameters$($NEEDS_ATTACH && echo ' + new parameter group')). NOT done by this script."
echo "Run in the owner-approved window. Reboot every member of the cluster:"
for inst in $MEMBERS; do
  echo "  aws rds reboot-db-instance --region $REGION --db-instance-identifier $inst"
done
echo "Then confirm: aws rds describe-db-clusters --region $REGION --db-cluster-identifier $CLUSTER_ID \\"
echo "  --query 'DBClusters[0].DBClusterMembers[].[DBInstanceIdentifier,DBClusterParameterGroupStatus]' --output table"
echo "  (every member must show in-sync), then SHOW shared_preload_libraries; on Aurora."
echo "================================================================================"
