#!/usr/bin/env bash
# Run this in AWS CloudShell (your own console session -- never Claude's).
# Diagnostic only -- makes NO permanent change. 564/566 tables have loaded
# successfully on the DMS full reload (VTID-03619); conversation_messages
# and reminders keep failing with SQLSTATE 2BP01 ("other objects depend on
# it") even reloaded alone, sequentially, with zero locks/idle transactions
# and nothing found via pg_depend against either table. That combination
# means Claude's read-only role can see the schema is clean, but something
# still blocks the real DROP -- the only way to get the actual PostgreSQL
# DETAIL line (which names the exact blocking object) is to attempt the
# real DROP with a role that has DDL rights, inside a transaction that
# gets rolled back either way so nothing is actually changed here.
set -euo pipefail

REGION="eu-central-1"
CLUSTER_ARN="arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-prod"
DB="vitana"

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

for T in conversation_messages reminders; do
  echo ""
  echo "=== Attempting DROP TABLE public.$T inside a transaction (will ROLLBACK, no real change) ==="
  TX_ID=$(aws rds-data begin-transaction --region "$REGION" \
    --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET_ARN" --database "$DB" \
    --query 'transactionId' --output text)
  if aws rds-data execute-statement --region "$REGION" \
    --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET_ARN" --database "$DB" \
    --transaction-id "$TX_ID" \
    --sql "DROP TABLE public.$T;" 2>/tmp/.diag_err_$T.log; then
    echo "UNEXPECTED: DROP succeeded (no error) -- rolling back anyway."
  else
    echo "--- Full error for $T (this is what we need): ---"
    cat /tmp/.diag_err_$T.log
    echo "---"
  fi
  aws rds-data rollback-transaction --region "$REGION" \
    --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET_ARN" --database "$DB" \
    --transaction-id "$TX_ID" >/dev/null
  rm -f /tmp/.diag_err_$T.log
  echo "Rolled back -- no change made to $T."
done

echo ""
echo "=== Done. Paste the two error blocks above back to Claude. ==="
