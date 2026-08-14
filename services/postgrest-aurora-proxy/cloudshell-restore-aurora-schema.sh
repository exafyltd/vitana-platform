#!/usr/bin/env bash
# Run this in AWS CloudShell (your own console session -- never Claude's).
#
# THE BIG FIX: AWS DMS's DROP_AND_CREATE full-load mode has been silently
# stripping RLS policies, column defaults, CHECK/UNIQUE constraints,
# secondary indexes, and triggers from every table it recreates -- it only
# ever preserves columns, types, and the primary key. Confirmed schema-wide:
# Aurora currently has 34 RLS policies / 92 indexes / 15 RLS-enabled tables
# where Supabase (the untouched source) has 1024 / 1367+92(PK) / 574.
#
# This restores all of it from Supabase, reconstructed via pg_policies /
# pg_get_constraintdef / pg_indexes / pg_get_triggerdef / information_schema
# on 2026-08-14 (VTID-03619). Every statement is idempotent (DO blocks
# swallowing duplicate_object, CREATE INDEX IF NOT EXISTS, DROP POLICY IF
# EXISTS before CREATE, defaults/RLS-enable are naturally idempotent) --
# safe to re-run from scratch if this CloudShell session resets again,
# which has happened repeatedly during this effort.
#
# Runs the 6 categories in parallel (they're independent of each other) so
# ~6587 statements complete in a reasonable time instead of serially.
set -uo pipefail

REGION="eu-central-1"
CLUSTER_ARN="arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-prod"
DB="vitana"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGDIR="$DIR/.restore-logs"
mkdir -p "$LOGDIR"

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
export MASTER_SECRET_ARN REGION CLUSTER_ARN DB

# Splits a file into statements on ';\n' (every statement this repo
# generates -- single-line or the multi-line CREATE POLICY blocks -- ends
# with a semicolon immediately before a newline), executes each via RDS
# Data API, tolerates individual failures (logs them, keeps going), and
# writes a running ok/fail count to its own log file.
run_category() {
  local file="$1"
  local name
  name="$(basename "$file" .sql)"
  local log="$LOGDIR/${name}.log"
  local ok=0 fail=0
  : > "$log"
  python3 -c "
import re, sys
lines = open('$file').read().split(chr(10))
# Drop the leading '-- header' comment line(s) BEFORE splitting on ';\n' --
# otherwise the header glues onto the first real statement (no semicolon
# between them) and the merged chunk gets discarded by the '--' filter
# below, silently dropping statement #1 of every file.
body_lines = [l for l in lines if not l.startswith('--')]
text = chr(10).join(body_lines)
parts = [p.strip() for p in text.split(';' + chr(10))]
for p in parts:
    if not p:
        continue
    print(p + ';')
    print('---STMT-END---')
" | {
    stmt=""
    while IFS= read -r line; do
      if [ "$line" == "---STMT-END---" ]; then
        if aws rds-data execute-statement --region "$REGION" \
          --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET_ARN" --database "$DB" \
          --sql "$stmt" >/dev/null 2>>"$log"; then
          ok=$((ok+1))
        else
          fail=$((fail+1))
          echo "FAILED: $stmt" >> "$log"
        fi
        stmt=""
      else
        if [ -z "$stmt" ]; then stmt="$line"; else stmt="$stmt
$line"; fi
      fi
    done
    echo "$name: $ok ok, $fail failed" | tee "$LOGDIR/${name}.summary"
  }
}
export -f run_category

echo ""
echo "=== Running all 6 categories in parallel (this will take a while -- check $LOGDIR for live progress) ==="
run_category "$DIR/aurora-restore-01-defaults.sql" &
run_category "$DIR/aurora-restore-02-check-unique-constraints.sql" &
run_category "$DIR/aurora-restore-03-indexes.sql" &
run_category "$DIR/aurora-restore-04-triggers.sql" &
run_category "$DIR/aurora-restore-05-rls-enable.sql" &
run_category "$DIR/aurora-restore-06-policies.sql" &
wait

echo ""
echo "=== Summary ==="
cat "$LOGDIR"/*.summary 2>/dev/null

echo ""
echo "=== Verification ==="
aws rds-data execute-statement --region "$REGION" \
  --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET_ARN" --database "$DB" \
  --sql "SELECT
    (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS policies,
    (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname NOT LIKE '%_pkey') AS indexes,
    (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal) AS triggers,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true) AS rls_enabled_tables,
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_default IS NOT NULL) AS defaults;" 2>&1

echo ""
echo "=== Done. Paste the Summary + Verification blocks above back to Claude. ==="
echo "Per-category full logs (including FAILED lines) are in $LOGDIR if anything needs investigating."
