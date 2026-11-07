#!/bin/bash
# Read-only checks + rollback proof in PGlite: live-before -> migrations -> post-apply-checks -> rollbacks (reverse) ->
# rollback-check -> re-apply. Usage: checks.sh
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05506; M=$R/supabase/migrations; T=$R/supabase/tests
node "$H/checks.mjs" "$T/vtid_05150_fixture.sql" "$M/20261014000100_vtid_05149_tenants_default_platform_flags.sql" "$T/vtid_05150_fixture_after_a.sql" \
  "$M/20261014000300_vtid_05149_ci_tenant_isolation_health.sql" "$M/20261014000400_vtid_05150_tenant_brand_pack.sql" "$M/20261014000500_vtid_05150_provision_tenant.sql" \
  "$V/live-before.sql" \
  "$M"/20261102141000_vtid_05506_*.sql "$M"/20261102141100_vtid_05506_*.sql \
  "$V/post-apply-checks.sql" \
  "$V/rollback-141100-isolation-health-by-tenant.sql" "$V/rollback-141000-provision-erp-request.sql" \
  "$V/rollback-check.sql" \
  "$V/rollback-141100-isolation-health-by-tenant.sql" "$V/rollback-141000-provision-erp-request.sql" \
  "$M"/20261102141000_vtid_05506_*.sql "$M"/20261102141100_vtid_05506_*.sql \
  "$V/post-apply-checks.sql" 2>&1
