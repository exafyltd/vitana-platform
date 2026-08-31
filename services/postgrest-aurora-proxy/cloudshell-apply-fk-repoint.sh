#!/usr/bin/env bash
# Run this in AWS CloudShell (your own console session -- never Claude's).
#
# Applies aurora-fk-repoint-app-users-2026-08-23.sql -- repoints Aurora's
# FK constraints from auth.users(id) to app_users(user_id), the
# identity-anchor step from docs/AURORA-EXCEPT-AUTH-ASSESSMENT.md (VTID-03702).
# See that SQL file's own header for the full rationale.
#
# Idempotent and safe to re-run: each statement is a DO block that skips an
# already-existing constraint and catches foreign_key_violation (logs a
# NOTICE, keeps going) rather than aborting -- so it's fine to run this
# before Aurora's data is fully current and just re-run it later for
# fuller coverage.
set -uo pipefail

REGION="eu-central-1"
CLUSTER_ARN="arn:aws:rds:eu-central-1:472838866351:cluster:vitana-aurora-prod"
DB="vitana"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$DIR/aurora-fk-repoint-app-users-2026-08-23.sql"

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

ok=0
fail=0
timedout=0
LOG="$DIR/.fk-repoint.log"
: > "$LOG"

echo ""
echo "=== Applying $SQL_FILE (116 statements) ==="
while IFS= read -r stmt; do
  [ -z "$stmt" ] && continue
  case "$stmt" in --*) continue ;; esac
  timeout 20s aws rds-data execute-statement --region "$REGION" \
    --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET_ARN" --database "$DB" \
    --sql "$stmt" >/dev/null 2>>"$LOG"
  rc=$?
  if [ $rc -eq 0 ]; then
    ok=$((ok+1))
  elif [ $rc -eq 124 ]; then
    timedout=$((timedout+1))
    echo "TIMEOUT (20s): $stmt" >> "$LOG"
  else
    fail=$((fail+1))
    echo "FAILED: $stmt" >> "$LOG"
  fi
done < "$SQL_FILE"

echo ""
echo "=== Summary: $ok ok, $fail failed, $timedout timed out (out of 116) ==="
echo "Full log (including FAILED lines and per-row FK-violation NOTICEs) in $LOG"

echo ""
echo "=== Verification ==="
aws rds-data execute-statement --region "$REGION" \
  --resource-arn "$CLUSTER_ARN" --secret-arn "$MASTER_SECRET_ARN" --database "$DB" \
  --sql "SELECT count(*) FROM pg_constraint c
JOIN pg_class rc ON rc.oid = c.confrelid
JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE c.contype='f' AND rn.nspname='public' AND rc.relname='app_users';" 2>&1

echo ""
echo "=== Done. Paste the Summary + Verification blocks above back to Claude. ==="
echo "If ok is well below 116, that's expected until a fresh full reload has run --"
echo "re-run this script after cloudshell-fix-dms-source-dns.sh's reload finishes."
