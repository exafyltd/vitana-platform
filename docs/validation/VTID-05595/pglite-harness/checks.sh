#!/bin/bash
# Read-only checks + rollback proof + guard proof in PGlite (no live system).
#   checks.sh        live-before -> migrations -> post-apply-checks -> rollbacks -> rollback-check -> re-apply -> post-apply-checks
#   checks.sh guard  an ambiguous member makes 130100 refuse and change nothing
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05595; M=$R/supabase/migrations
M0=$(ls "$M"/20261102130000_vtid_05595_*.sql); M1=$(ls "$M"/20261102130100_vtid_05595_*.sql)
if [ "$1" = guard ]; then
  node "$H/checks.mjs" "$H/base_schema.sql" "$H/fixture-ambiguous.sql" "$V/live-before.sql" "$M0" "expect-error:$M1" "$H/guard-check.sql" 2>&1
else
  node "$H/checks.mjs" "$H/base_schema.sql" "$H/fixture-members.sql" "$V/live-before.sql" "$M0" "$M1" "$V/post-apply-checks.sql" \
    "$V/rollback-130100-health-home-tenant-resolver-backfill.sql" "$V/rollback-130000-health-home-tenant-column.sql" "$V/rollback-check.sql" \
    "$M0" "$M1" "$V/post-apply-checks.sql" 2>&1
fi
