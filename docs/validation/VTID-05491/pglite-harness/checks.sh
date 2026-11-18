#!/bin/bash
# Read-only checks + rollback proof in PGlite: live-before -> migrations -> post-apply-checks -> rollbacks (reverse) -> rollback-check
# -> re-apply -> post-apply-checks. Also proves the guards: the P2 rollback refuses while P3 exists. Usage: checks.sh
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05491; M=$R/supabase/migrations
MIGS=("$M"/20261102070100_vtid_05491_*.sql "$M"/20261102070150_vtid_05491_*.sql "$M"/20261102070600_vtid_05491_*.sql)
RB=("$V/rollback-070600-moderator-tenant-scope.sql" "$V/rollback-070150-p3-moderation.sql" "$V/rollback-070100-p2-moderation.sql")
node "$H/checks.mjs" "$H/base_schema.sql" "$V/pgtap/vtid_05491_fixture.sql" "$V/live-before.sql" "${MIGS[@]}" "$V/post-apply-checks.sql" \
  "${RB[@]}" "$V/rollback-check.sql" "${MIGS[@]}" "$V/post-apply-checks.sql" "${RB[@]}" "$V/rollback-check.sql" 2>&1
echo "## guard: P2 rollback must refuse while P3 exists"
node "$H/checks.mjs" "$H/base_schema.sql" "$V/pgtap/vtid_05491_fixture.sql" "${MIGS[@]}" "${RB[0]}" "${RB[2]}" 2>&1 | tail -n 2
