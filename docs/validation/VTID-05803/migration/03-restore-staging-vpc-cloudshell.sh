#!/usr/bin/env bash
# VTID-05803 — restore into EXISTING vitana-aurora-staging. Run in the VPC-attached CloudShell
# (vpc-05958f035e596fe64, subnet-0ff45a2051c5e5482, sg-0a8531c0ec2130457). Argument 1: the export directory.
# Thin Aurora wrapper: fetches the cluster master credentials in memory, installs the approved Aurora extensions,
# then runs restore-core.sh (the same sequence the synthetic rehearsal runs).
set -euo pipefail
export AWS_DEFAULT_REGION=eu-central-1
HERE="$(cd "$(dirname "$0")" && pwd)"
EXPORT_DIR=${1:?usage: $0 <export-dir>}
W=vitana-aurora-staging.cluster-cfk228aiedf3.eu-central-1.rds.amazonaws.com
# 0. guard: staging only, never production, rehearsal or DR
case "$W" in *prod*|*rehearsal*|*awsdr*) echo "REFUSED: target" >&2; exit 1;; esac
MASTER_ARN=$(aws rds describe-db-clusters --db-cluster-identifier vitana-aurora-staging --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text)
MASTER_JSON=$(aws secretsmanager get-secret-value --secret-id "$MASTER_ARN" --query SecretString --output text)
export PGPASSWORD=$(printf '%s' "$MASTER_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')
ADMIN=$(printf '%s' "$MASTER_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["username"])'); unset MASTER_JSON
export PGSSLMODE=require
export P="-h $W -p 5432 -U $ADMIN -d vitana"
# 1. Aurora-supported extensions only (pgmq, pg_net, supabase_vault intentionally NOT installed). Fail closed.
for E in vector pg_trgm unaccent fuzzystrmatch uuid-ossp pgcrypto pg_stat_statements; do
  psql $P -X -v ON_ERROR_STOP=1 -q -c "CREATE EXTENSION IF NOT EXISTS \"$E\""
done
# 2. the shared sequence (checksums, prerequisites, ordered restore, outbox, host exclusion, preservation, cron)
bash "$HERE/restore-core.sh" "$EXPORT_DIR" | tee "$EXPORT_DIR/restore-report.txt"
unset PGPASSWORD
echo "restore finished; see restore-report.txt. Acceptance tests are the next step; staging stays suspended until they pass."
