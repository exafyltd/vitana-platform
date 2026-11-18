#!/bin/bash
# Read-only checks + rollback proof in PGlite: live-before -> migrations -> post-apply-checks -> rollbacks (reverse) -> rollback-check
# -> re-apply (rollbacks are re-appliable). Usage: checks.sh
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05488; M=$R/supabase/migrations
node "$H/checks.mjs" "$H/base_schema.sql" "extract:$M/20260218000000_fix_maxina_signup_tenant_association.sql" "$V/pgtap/vtid_05488_fixture.sql" \
  "$V/live-before.sql" \
  "$M"/20261102120000_vtid_05488_*.sql "$M"/20261102120100_vtid_05488_*.sql "$M"/20261102120200_vtid_05488_*.sql "$M"/20261102120300_vtid_05488_*.sql \
  "$V/post-apply-checks.sql" \
  "$V/rollback-120300-products-merchants-tenant-rls.sql" "$V/rollback-120200-partner-tenant-backfill.sql" "$V/rollback-120100-products-distribution.sql" "$V/rollback-120000-supplier-tenant-relationships.sql" \
  "$V/rollback-check.sql" \
  "$V/rollback-120300-products-merchants-tenant-rls.sql" "$V/rollback-120200-partner-tenant-backfill.sql" "$V/rollback-120100-products-distribution.sql" "$V/rollback-120000-supplier-tenant-relationships.sql" \
  "$M"/20261102120000_vtid_05488_*.sql "$M"/20261102120100_vtid_05488_*.sql "$M"/20261102120200_vtid_05488_*.sql "$M"/20261102120300_vtid_05488_*.sql \
  "$V/post-apply-checks.sql" 2>&1
