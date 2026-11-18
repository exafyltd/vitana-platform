#!/usr/bin/env bash
# Staging vector post-load for the Supabase -> Aurora migration (vitana-aurora-staging only).
#
# Run it after the DMS full load on staging has finished. It does three things and nothing else:
#   plan    print the statements of staging-db-vector-postload.sql and the target; NO AWS call
#   apply   apply staging-db-vector-postload.sql in ONE Data API transaction through staging-db-apply-migration.sh
#           (all or nothing: any failure rolls every statement back). It casts the 13 staged text columns back to
#           pgvector, keeps every incomplete value in migration_audit.vector_incomplete, and recreates the 9 vector
#           indexes. It never truncates, deletes or reloads data.
#   report  run the SELECTs of staging-db-vector-report.sql and print the rows as JSON (read-only), for the operator
#           and for independent validation
#
# Usage: bash scripts/aws/staging-db-vector-postload.sh plan|apply|report --cluster vitana-aurora-staging
#
# Guards (same as staging-db-apply-migration.sh): --cluster is required and has no default, and any name that
# contains "prod" is refused before any AWS call. The credentials must be the staging database role in 472838866351,
# and the cluster must be tagged vitana-env=staging and use an RDS-managed master secret. No secret value is printed.
# The next step after apply is the embedding backfill:
#   python3 scripts/aws/aurora-cutover-embedding-backfill.py --cluster vitana-aurora-staging
# Exit: 0 ok; 1 refused or failed; 2 usage.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=staging-db-common.sh
. "$HERE/staging-db-common.sh"
DB=vitana
STAGING_ROLE_NAME=vitana-gha-staging-db
SQL="$HERE/staging-db-vector-postload.sql"
REPORT="$HERE/staging-db-vector-report.sql"

MODE="${1:-}"; [ $# -gt 0 ] && shift
CLUSTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) CLUSTER="${2:-}"; shift 2 ;;
    *) sdb_usage "unknown argument: $1" ;;
  esac
done
case "$MODE" in plan|apply|report) ;; *) sdb_usage "usage: $0 plan|apply|report --cluster vitana-aurora-staging" ;; esac
sdb_check_cluster "$CLUSTER"

case "$MODE" in
  plan)  exec bash "$HERE/staging-db-apply-migration.sh" --cluster "$CLUSTER" --file "$SQL" --dry-run ;;
  apply) exec bash "$HERE/staging-db-apply-migration.sh" --cluster "$CLUSTER" --file "$SQL" ;;
esac

# ---- report: read-only SELECTs, rows printed as JSON ----------------------------------------------------------------
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
if [ -n "${AWS_REGION:-}" ] && [ "$AWS_REGION" != "$SDB_REGION" ]; then sdb_die "AWS_REGION=$AWS_REGION, expected $SDB_REGION"; fi
aws sts get-caller-identity --output json > "$WORK/id.json" || sdb_die "aws sts get-caller-identity failed"
[ "$(jq -r .Account "$WORK/id.json")" = "$SDB_ACCOUNT" ] || sdb_die "credentials are for account $(jq -r .Account "$WORK/id.json"), expected $SDB_ACCOUNT"
case "$(jq -r .Arn "$WORK/id.json")" in
  "arn:aws:sts::$SDB_ACCOUNT:assumed-role/$STAGING_ROLE_NAME/"*) ;;
  *) sdb_die "refused: credentials are not the staging database role $STAGING_ROLE_NAME" ;;
esac
aws rds describe-db-clusters --region "$SDB_REGION" --db-cluster-identifier "$CLUSTER" --output json > "$WORK/cluster.json" \
  || sdb_die "cluster $CLUSTER not found"
CLUSTER_ARN=$(jq -r '.DBClusters[0].DBClusterArn // ""' "$WORK/cluster.json")
[ "$CLUSTER_ARN" = "$(sdb_cluster_arn "$CLUSTER")" ] || sdb_die "unexpected cluster ARN '$CLUSTER_ARN'"
[ "$(jq -r '[.DBClusters[0].TagList[]? | select(.Key == "vitana-env") | .Value][0] // ""' "$WORK/cluster.json")" = "staging" ] \
  || sdb_die "cluster $CLUSTER is not tagged vitana-env=staging"
SECRET_ARN=$(jq -r '.DBClusters[0].MasterUserSecret.SecretArn // ""' "$WORK/cluster.json")
case "$SECRET_ARN" in "arn:aws:secretsmanager:$SDB_REGION:$SDB_ACCOUNT:secret:"*) ;; *) sdb_die "cluster $CLUSTER has no RDS-managed master secret" ;; esac

# Statements are separated by a line that is exactly "-- ;;"; other comment lines are dropped.
awk -v dir="$WORK" 'BEGIN{n=1} /^-- ;;$/{n++; next} /^--/{next} {print > (dir "/q" n ".sql")}' "$REPORT"
for q in "$WORK"/q*.sql; do
  stmt="$(cat "$q")"
  case "$(printf '%s' "$stmt" | tr '[:lower:]' '[:upper:]' | sed 's/^[[:space:]]*//')" in SELECT*) ;; *) sdb_die "report: only SELECT statements are allowed ($q)" ;; esac
  echo "== $(basename "$q" .sql)"
  aws rds-data execute-statement --region "$SDB_REGION" --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" \
    --database "$DB" --format-records-as JSON --sql "$stmt" --output json | jq -r '.formattedRecords' | jq .
done
echo "report: done (read-only)"
