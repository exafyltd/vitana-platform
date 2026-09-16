#!/usr/bin/env bash
# Run this in AWS CloudShell (your own console session -- never Claude's).
# Round 2 of unblocking the DMS full reload: after the 245 FK constraints
# were dropped (cloudshell-unblock-aurora.sh), DMS's plain `DROP TABLE`
# (DROP_AND_CREATE prep mode, no CASCADE) started hitting the same
# SQLSTATE 2BP01 "other objects depend on it" error on 4 tables so far
# (agent_personas, ai_recommendations, ai_usage_log, app_users) -- this
# time the blocker is 20 views/materialized views across ~25 tables, not
# FK constraints (confirmed: pg_constraint FK count is 0).
#
# Drops all 20 up front (schema-wide, not just the 4 that have errored so
# far) so the running reload doesn't keep tripping table-by-table as it
# works through the remaining ~520 queued tables. Fully reversible via
# aurora-view-restore-2026-08-13.sql, captured from live pg_get_viewdef()
# output before the drop.
set -euo pipefail

REGION="eu-central-1"
CLUSTER_ARN="arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-prod"
DB="vitana"
TASK_ARN="arn:aws:dms:eu-central-1:472838866351:task:6HXJWOLRF5FA3DND3TLMGXHY4I"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Resolving Aurora master secret ==="
MASTER_SECRET_ARN="${MASTER_SECRET_ARN:-}"
if [ -z "$MASTER_SECRET_ARN" ]; then
  MASTER_SECRET_ARN=$(aws rds describe-db-clusters --region "$REGION" \
    --db-cluster-identifier vitana-aurora-prod \
    --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text 2>/dev/null || true)
fi
if [ -z "$MASTER_SECRET_ARN" ] || [ "$MASTER_SECRET_ARN" == "None" ]; then
  echo "ERROR: could not resolve the Aurora master secret. Set MASTER_SECRET_ARN=<arn> and re-run." >&2
  exit 1
fi
echo "Using master secret: $MASTER_SECRET_ARN"

echo ""
echo "=== Dropping 20 views/matviews blocking DMS DROP_AND_CREATE ==="
ok=0
fail=0
while IFS= read -r stmt; do
  [ -z "$stmt" ] && continue
  case "$stmt" in \#*) continue ;; esac
  if aws rds-data execute-statement --region "$REGION" \
    --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET_ARN" --database "$DB" \
    --sql "$stmt" >/dev/null 2>"$DIR/.view_drop_err.log"; then
    ok=$((ok+1))
  else
    fail=$((fail+1))
    echo "FAILED: $stmt" >&2
    cat "$DIR/.view_drop_err.log" >&2
  fi
done < <(grep -E '^(DROP VIEW|DROP MATERIALIZED VIEW)' "$DIR/aurora-view-drop-2026-08-13.sql")
rm -f "$DIR/.view_drop_err.log"
echo ""
echo "View drops: $ok ok, $fail failed"
if [ "$fail" -gt 0 ]; then
  echo "ERROR: not all views dropped -- investigate before restarting the reload." >&2
  exit 1
fi

echo ""
echo "=== Reloading the 4 tables that already suspended, so they pick up now that views are gone ==="
aws dms reload-tables --region "$REGION" \
  --replication-task-arn "$TASK_ARN" \
  --tables-to-reload SchemaName=public,TableName=agent_personas SchemaName=public,TableName=ai_recommendations SchemaName=public,TableName=ai_usage_log SchemaName=public,TableName=app_users \
  --reload-option data-reload 2>&1 || echo "NOTE: reload-tables call failed -- check manually with: aws dms describe-table-statistics --replication-task-arn $TASK_ARN"

echo ""
echo "=== Done ==="
echo "20 views/matviews dropped (restorable via aurora-view-restore-2026-08-13.sql)."
echo "The 4 already-suspended tables were told to reload. The rest of the queue"
echo "(~520 tables) should now sail through without hitting this class of error."
echo "Claude's session will pick up monitoring from here."
