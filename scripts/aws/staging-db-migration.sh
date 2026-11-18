#!/usr/bin/env bash
# Staging data migration around the DMS full load (Supabase -> Aurora, vitana-aurora-staging only), on the schema
# that the VTID-05803 path built (the schema-restore package, or the migration replay). Every step runs through the
# staging execution path staging-db-apply-migration.sh, and each SQL file is one Data API transaction (all or nothing).
#
#   pre-load   BEFORE the DMS full load:
#                staging-db-vector-preload.sql   save and drop the public foreign keys, the views on vector columns
#                                                and the vector indexes; vector columns become text
#   (DMS)      the existing task vitana-fullload-final-catchup loads staging (TRUNCATE_BEFORE_LOAD)
#   post-load  AFTER the DMS full load:
#                1/2 staging-db-vector-postload.sql   text back to vector, incomplete values kept, the 9 vector indexes
#                2/2 staging-db-restore-saved.sql     saved indexes, foreign keys (NOT VALID) and views back; the
#                                                     public -> auth foreign keys stay out (owner decision R2)
#   then       python3 scripts/aws/aurora-cutover-embedding-backfill.py --cluster vitana-aurora-staging
#              bash scripts/aws/staging-db-vector-postload.sh report --cluster vitana-aurora-staging
# The post-load stops at the first failed file (rolled back); a file applied before it stays applied. Every file is
# idempotent, so a re-run continues. Nothing is truncated, deleted or reloaded by these files.
#
# Usage: bash scripts/aws/staging-db-migration.sh pre-load|post-load --cluster vitana-aurora-staging [--plan]
#   --plan prints the plans (statement counts, target) and makes NO AWS call.
# Guards: those of staging-db-apply-migration.sh. A cluster name with "prod" is refused before any AWS call, and the
# step needs the staging database role, the vitana-env=staging tag and the RDS-managed master secret.
# Exit: 0 applied (or planned); 1 refused or failed; 2 usage.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=staging-db-common.sh
. "$HERE/staging-db-common.sh"

USAGE="usage: $0 pre-load|post-load --cluster vitana-aurora-staging [--plan]"
MODE="${1:-}"; [ $# -gt 0 ] && shift
CLUSTER=""; PLAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) CLUSTER="${2:-}"; shift 2 ;;
    --plan) PLAN=1; shift ;;
    *) sdb_usage "$USAGE" ;;
  esac
done
case "$MODE" in
  pre-load)  STEPS=("pre-load|$HERE/staging-db-vector-preload.sql") ;;
  post-load) STEPS=("vector post-load|$HERE/staging-db-vector-postload.sql" "restore saved objects|$HERE/staging-db-restore-saved.sql") ;;
  *) sdb_usage "$USAGE" ;;
esac
sdb_check_cluster "$CLUSTER"

n=0
for step in "${STEPS[@]}"; do
  n=$((n+1)); label="${step%%|*}"; file="${step#*|}"
  echo "== $MODE $n/${#STEPS[@]} $label ($(basename "$file"))"
  if [ "$PLAN" = 1 ]; then
    bash "$HERE/staging-db-apply-migration.sh" --cluster "$CLUSTER" --file "$file" --dry-run
  else
    bash "$HERE/staging-db-apply-migration.sh" --cluster "$CLUSTER" --file "$file" \
      || sdb_die "$MODE step $n/${#STEPS[@]} ($label) failed and was rolled back; earlier steps stay applied. Re-run after the fix (every step is idempotent)."
  fi
done
echo "ALL DONE: $MODE, ${#STEPS[@]} step(s) on $CLUSTER$([ "$PLAN" = 1 ] && echo ' (plan only, no AWS call)')"
