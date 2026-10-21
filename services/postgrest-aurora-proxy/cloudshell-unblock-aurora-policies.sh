#!/usr/bin/env bash
# Run this in AWS CloudShell (your own console session -- never Claude's).
# Round 3 of unblocking the DMS full reload. After the 245 FK drops and 20
# view drops, the reload got to 561/566 tables. The remaining 5
# (memberships, conversation_messages, global_community_events, reminders,
# event_co_creators) kept hitting SQLSTATE 2BP01 on retry. Root cause,
# confirmed live via pg_depend/pg_policies:
#   - global_community_events <-> event_co_creators: each table's RLS
#     policies subquery the OTHER table, a genuine cross-table cycle no
#     amount of blind retrying resolves.
#   - memberships <- user_intents: user_intents' (already-recreated) read
#     policies subquery memberships, blocking its drop.
#   - conversation_messages / reminders: no current blocker found -- almost
#     certainly transient races from concurrent DMS threads; a plain retry
#     should clear them.
#
# Drops the 6 blocking policies (reversible via
# aurora-policy-restore-2026-08-13.sql, captured verbatim beforehand), then
# reloads all 5 remaining tables.
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
echo "=== Dropping 6 RLS policies forming cross-table dependency cycles ==="
ok=0
fail=0
while IFS= read -r stmt; do
  [ -z "$stmt" ] && continue
  case "$stmt" in \#*|--*) continue ;; esac
  if aws rds-data execute-statement --region "$REGION" \
    --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET_ARN" --database "$DB" \
    --sql "$stmt" >/dev/null 2>"$DIR/.policy_drop_err.log"; then
    ok=$((ok+1))
  else
    fail=$((fail+1))
    echo "FAILED: $stmt" >&2
    cat "$DIR/.policy_drop_err.log" >&2
  fi
done < <(grep -E '^DROP POLICY' "$DIR/aurora-policy-drop-2026-08-13.sql")
rm -f "$DIR/.policy_drop_err.log"
echo ""
echo "Policy drops: $ok ok, $fail failed"
if [ "$fail" -gt 0 ]; then
  echo "ERROR: not all policies dropped -- investigate before restarting the reload." >&2
  exit 1
fi

echo ""
echo "=== Reloading the 5 remaining tables ==="
aws dms reload-tables --region "$REGION" \
  --replication-task-arn "$TASK_ARN" \
  --tables-to-reload SchemaName=public,TableName=memberships SchemaName=public,TableName=conversation_messages SchemaName=public,TableName=global_community_events SchemaName=public,TableName=reminders SchemaName=public,TableName=event_co_creators \
  --reload-option data-reload 2>&1

echo ""
echo "=== Done ==="
echo "6 policies dropped (restorable via aurora-policy-restore-2026-08-13.sql)."
echo "5 tables told to reload. Claude's session will pick up monitoring from here."
