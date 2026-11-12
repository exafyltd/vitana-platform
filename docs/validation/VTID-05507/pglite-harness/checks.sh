#!/bin/bash
# Read-only checks + rollback proof in PGlite: live-before -> migrations -> post-apply-checks -> rollbacks (reverse) ->
# rollback-check -> re-apply (rollbacks are re-appliable). Usage: checks.sh
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05507; M=$R/supabase/migrations
node "$H/checks.mjs" "$H/base_schema.sql" "$V/pgtap/vtid_05507_fixture.sql" "$M/20261014000600_vtid_05151_public_tenant_registry.sql" \
  "$V/live-before.sql" \
  "$M"/20261102140000_vtid_05507_*.sql "$M"/20261102140100_vtid_05507_*.sql \
  "$V/post-apply-checks.sql" \
  "$V/rollback-140100-resolve-tenant-host.sql" "$V/rollback-140000-tenant-domains.sql" \
  "$V/rollback-check.sql" \
  "$V/rollback-140100-resolve-tenant-host.sql" "$V/rollback-140000-tenant-domains.sql" \
  "$M"/20261102140000_vtid_05507_*.sql "$M"/20261102140100_vtid_05507_*.sql \
  "$V/post-apply-checks.sql" 2>&1
