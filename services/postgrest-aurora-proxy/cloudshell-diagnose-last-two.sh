#!/usr/bin/env bash
# Run this in AWS CloudShell (your own console session -- never Claude's).
# Diagnostic only -- makes NO permanent change. 564/566 tables have loaded
# successfully on the DMS full reload (VTID-03619); conversation_messages
# and reminders keep failing with SQLSTATE 2BP01 even reloaded alone,
# sequentially, with zero locks/idle transactions and nothing found via
# pg_depend against either table -- read-only diagnosis is exhausted, and
# a first pass at this script found RDS Data API's error surfacing does
# NOT include Postgres's DETAIL line (only MESSAGE + HINT), so a plain
# DROP attempt can't name the blocking object even via a real DDL role.
#
# This version tries DROP TABLE ... CASCADE instead, still inside a
# transaction that always rolls back (no permanent change either way).
# If CASCADE succeeds where plain DROP fails, that confirms something
# real (if invisible to the read-only role's pg_depend queries) is
# blocking it, and CASCADE is safe to actually commit next: DMS reloads
# these tables' data fresh regardless, and every dependency check so far
# found only self-owned indexes/constraints/triggers/policies -- i.e.
# nothing CASCADE would remove that DMS wouldn't already be replacing.
set -uo pipefail  # no -e: this script handles its own failures per-table

REGION="eu-central-1"
CLUSTER_ARN="arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-prod"
DB="vitana"

echo "=== Resolving Aurora master secret ==="
MASTER_SECRET_ARN="${MASTER_SECRET_ARN:-}"
if [ -z "$MASTER_SECRET_ARN" ]; then
  MASTER_SECRET_ARN=$(aws rds describe-db-clusters --region "$REGION" \
    --db-cluster-identifier vitana-aurora-prod \
    --query 'DBClusters[0].MasterUserSecret.SecretArn' --output text 2>/dev/null)
fi
if [ -z "$MASTER_SECRET_ARN" ] || [ "$MASTER_SECRET_ARN" == "None" ]; then
  echo "ERROR: could not resolve the Aurora master secret. Set MASTER_SECRET_ARN=<arn> and re-run." >&2
  exit 1
fi
echo "Using master secret: $MASTER_SECRET_ARN"

for T in conversation_messages reminders; do
  echo ""
  echo "=== $T: attempting DROP TABLE ... CASCADE inside a transaction (will ROLLBACK) ==="

  TX_JSON=$(aws rds-data begin-transaction --region "$REGION" \
    --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET_ARN" --database "$DB" 2>&1)
  TX_ID=$(printf '%s' "$TX_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['transactionId'])" 2>/dev/null)
  if [ -z "$TX_ID" ]; then
    echo "ERROR: could not begin a transaction for $T. Raw output:" >&2
    echo "$TX_JSON" >&2
    continue
  fi

  if aws rds-data execute-statement --region "$REGION" \
    --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET_ARN" --database "$DB" \
    --transaction-id "$TX_ID" \
    --sql "DROP TABLE public.$T CASCADE;" 2>/tmp/.diag_err_$T.log; then
    echo "RESULT for $T: CASCADE SUCCEEDED (would need a real, non-rolled-back CASCADE to actually unblock it)."
  else
    echo "RESULT for $T: CASCADE ALSO FAILED. Full error:"
    cat /tmp/.diag_err_$T.log
  fi
  rm -f /tmp/.diag_err_$T.log

  ROLLBACK_OUT=$(aws rds-data rollback-transaction --region "$REGION" \
    --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET_ARN" --database "$DB" \
    --transaction-id "$TX_ID" 2>&1)
  if [ $? -ne 0 ]; then
    echo "WARNING: rollback call itself reported an error (likely harmless -- the tx may have already" >&2
    echo "auto-rolled-back on the failed statement above). Raw output:" >&2
    echo "$ROLLBACK_OUT" >&2
  else
    echo "Rolled back -- no permanent change made to $T."
  fi
done

echo ""
echo "=== Done. Paste the two RESULT lines (and any CASCADE error text) back to Claude. ==="
