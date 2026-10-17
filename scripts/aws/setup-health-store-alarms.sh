#!/usr/bin/env bash
#
# VTID-05159 (Health Hub Phase 1 / A2, plan Change 11) — CloudWatch metric
# filters and alarms for the health store.
#
# The gateway writes one JSON log line per event (no member ids, no values):
#   {"event":"health_store_maintenance","ok":true|false,...}        every hourly run
#   {"event":"health_store_partition_check","missing":N,...}         the 02:23 UTC run
#   {"event":"health.store.partition_missing","items":N,...}         a write found no partition
#   {"event":"health_store_capacity","series_5m_rows_estimate":N,"connected_device_sources":N}  the 02:23 UTC run
#   {"event":"health_store_ingest","items":N,...}                     every writeHealthSamples call
# (services/gateway/src/services/health-store/{maintenance,ingest}.ts).
#
# Alarms (-> SNS vitana-alarms-prod):
#   1. no successful maintenance run for 4 hours (the job runs hourly);
#   2. tomorrow's partition missing in any tier (daily check);
#   3. any write that still found no partition after ensure + retry;
#   placement re-evaluation triggers (plan Change 4):
#   4. 5-minute tier > 150 GB  (planner row estimate > 750,000,000 rows at 200 B/row);
#   5. health upserts > 1,000/s sustained for 1 hour (> 60,000 items per minute, 60 minutes);
#   6. > 15,000 connected members (connected device-type sources, an upper bound).
#   The fourth trigger — health tables > 40% of cluster write I/O for a week —
#   has no log or CloudWatch metric per table; it is a weekly manual check in
#   Performance Insights (top SQL by health_store_ingest) and is printed below.
#
# Dry run by default (prints, calls nothing). --apply is OWNER-RUN.
# Idempotent: put-metric-filter / put-metric-alarm overwrite by name.
#
# Usage:
#   scripts/aws/setup-health-store-alarms.sh prod            # dry run
#   scripts/aws/setup-health-store-alarms.sh prod --apply    # owner only
#   LOG_GROUP=/vitana/gateway-0t scripts/aws/setup-health-store-alarms.sh 0t --apply
set -euo pipefail
export AWS_PAGER=""

REGION="eu-central-1"
ACCOUNT="472838866351"
ENV_NAME="${1:-}"
APPLY=false
[ "${2:-}" = "--apply" ] && APPLY=true

case "$ENV_NAME" in
  prod) LOG_GROUP="${LOG_GROUP:-/vitana/gateway-awsdr}" ;;
  0t)
    if [ -z "${LOG_GROUP:-}" ]; then
      echo "ERROR: set LOG_GROUP to the 0T gateway's log group." >&2
      exit 1
    fi ;;
  staging)
    echo "ERROR: the health store is forced off on staging; no alarms there." >&2
    exit 1 ;;
  *)
    echo "Usage: $0 <prod|0t> [--apply]" >&2
    exit 1 ;;
esac

NAMESPACE="Vitana/HealthStore"
ALARM_TOPIC="arn:aws:sns:${REGION}:${ACCOUNT}:vitana-alarms-prod"

run() {
  if $APPLY; then "$@"; else echo "[dry-run] $(printf '%q ' "$@")"; fi
}

if $APPLY; then
  CURRENT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo unknown)"
  if [ "$CURRENT_ACCOUNT" != "$ACCOUNT" ]; then
    echo "ERROR: caller is account '$CURRENT_ACCOUNT', expected '$ACCOUNT'. Refusing." >&2
    exit 1
  fi
fi

echo "=== Health store alarms (VTID-05159) — env $ENV_NAME, log group $LOG_GROUP ==="

# name | filter pattern | metric | value
filter() {
  run aws logs put-metric-filter --region "$REGION" \
    --log-group-name "$LOG_GROUP" \
    --filter-name "vitana-health-store-$1-${ENV_NAME}" \
    --filter-pattern "$2" \
    --metric-transformations \
      "metricName=$3,metricNamespace=${NAMESPACE},metricValue=$4,defaultValue=0,dimensions={Environment=${ENV_NAME}},unit=Count"
}

filter maintenance-ok   '{ $.event = "health_store_maintenance" && $.ok IS TRUE }' MaintenanceSucceeded 1
filter partition-check  '{ $.event = "health_store_partition_check" }'             PartitionsMissingTomorrow '$.missing'
filter partition-writes '{ $.event = "health.store.partition_missing" }'           PartitionMissingWrites '$.items'
filter series-5m-rows   '{ $.event = "health_store_capacity" }'                     Series5mRowsEstimate '$.series_5m_rows_estimate'
filter connected        '{ $.event = "health_store_capacity" }'                     ConnectedDeviceSources '$.connected_device_sources'
filter upserts          '{ $.event = "health_store_ingest" }'                       IngestItems '$.items'

# name | metric | statistic | period | evaluation periods | threshold | comparison | missing-data | description
alarm() {
  run aws cloudwatch put-metric-alarm --region "$REGION" \
    --alarm-name "vitana-health-store-$1-${ENV_NAME}" \
    --alarm-description "VTID-05159: $9" \
    --namespace "$NAMESPACE" --metric-name "$2" \
    --dimensions "Name=Environment,Value=${ENV_NAME}" \
    --statistic "$3" --period "$4" --evaluation-periods "$5" \
    --threshold "$6" --comparison-operator "$7" \
    --treat-missing-data "$8" \
    --alarm-actions "$ALARM_TOPIC"
}

alarm maintenance-stale     MaintenanceSucceeded      Sum     14400 1  1          LessThanThreshold    breaching    "no successful health store maintenance run (ensure partitions + purge) for 4 hours"
alarm partition-missing     PartitionsMissingTomorrow Maximum 86400 1  0          GreaterThanThreshold notBreaching "tomorrow's health store partition is missing in at least one tier"
alarm partition-writes      PartitionMissingWrites    Sum     300   1  0          GreaterThanThreshold notBreaching "health store writes answered store_unavailable: no partition after ensure + retry"
alarm placement-5m-size     Series5mRowsEstimate      Maximum 86400 1  750000000  GreaterThanThreshold notBreaching "placement trigger: 5-minute tier above ~150 GB — open the placement re-evaluation plan"
alarm placement-upserts     IngestItems               Sum     60    60 60000      GreaterThanThreshold notBreaching "placement trigger: health upserts above 1,000/s sustained for 1 hour"
alarm placement-connected   ConnectedDeviceSources    Maximum 86400 1  15000      GreaterThanThreshold notBreaching "placement trigger: more than 15,000 connected sources (members upper bound)"

echo
echo "NOT ALARMED (no per-table CloudWatch metric): placement trigger 'health tables > 40% of cluster write I/O for a week'."
echo "  Weekly manual check: Aurora Performance Insights, top SQL by write I/O, share of health_store_ingest / health_store_purge."
$APPLY && echo "Applied." || echo "Dry run only. Re-run with --apply (owner-run)."
