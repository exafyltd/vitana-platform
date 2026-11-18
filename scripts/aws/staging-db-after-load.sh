#!/usr/bin/env bash
# Staging after-load sequence for the Supabase -> Aurora migration (vitana-aurora-staging only). It is the staging
# twin of aurora-cutover-after-load.sh: the same SQL, sent through the staging execution path
# (staging-db-apply-migration.sh) instead of the production cluster. Run it after the DMS full load on staging.
#
#   1/3 scripts/aws/staging-db-vector-postload.sql            vectors back to pgvector, incomplete values kept, 9 indexes
#   2/3 scripts/aws/aurora-cutover-recreate-foreign-keys.sql   Supabase's public->public FKs (NOT VALID, no public->auth FK)
#   3/3 scripts/aws/aurora-cutover-schema-sync-views.sql       the views (CREATE OR REPLACE), PostgREST reload
# Each file is one Data API transaction (all or nothing). The first failure stops the sequence; files applied earlier
# stay applied. Every file is idempotent, so a re-run picks up where it stopped. Nothing is truncated, deleted or
# reloaded.
# Next: python3 scripts/aws/aurora-cutover-embedding-backfill.py --cluster vitana-aurora-staging, then
#       bash scripts/aws/staging-db-vector-postload.sh report --cluster vitana-aurora-staging
#
# Usage: bash scripts/aws/staging-db-after-load.sh --cluster vitana-aurora-staging [--plan]
#   --plan prints the three plans (statement counts, target) and makes NO AWS call.
# Guards: the ones of staging-db-apply-migration.sh. Any cluster name containing "prod" is refused before any AWS
# call, and it needs the staging database role, the vitana-env=staging tag and the RDS-managed master secret.
# Exit: 0 all three applied (or planned); 1 refused or failed; 2 usage.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=staging-db-common.sh
. "$HERE/staging-db-common.sh"

CLUSTER=""; PLAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) CLUSTER="${2:-}"; shift 2 ;;
    --plan) PLAN=1; shift ;;
    *) sdb_usage "usage: $0 --cluster vitana-aurora-staging [--plan]" ;;
  esac
done
sdb_check_cluster "$CLUSTER"

STEPS=(
  "vector post-load|$HERE/staging-db-vector-postload.sql"
  "foreign keys|$HERE/aurora-cutover-recreate-foreign-keys.sql"
  "views|$HERE/aurora-cutover-schema-sync-views.sql"
)
n=0
for step in "${STEPS[@]}"; do
  n=$((n+1)); label="${step%%|*}"; file="${step#*|}"
  echo "== $n/${#STEPS[@]} $label ($(basename "$file"))"
  if [ "$PLAN" = 1 ]; then
    bash "$HERE/staging-db-apply-migration.sh" --cluster "$CLUSTER" --file "$file" --dry-run
  else
    bash "$HERE/staging-db-apply-migration.sh" --cluster "$CLUSTER" --file "$file" \
      || sdb_die "step $n/${#STEPS[@]} ($label) failed and was rolled back; steps before it stay applied. Fix it and re-run (every step is idempotent)."
  fi
done
echo "ALL DONE: ${#STEPS[@]} step(s) on $CLUSTER$([ "$PLAN" = 1 ] && echo ' (plan only, no AWS call)')"
