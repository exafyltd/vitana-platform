#!/bin/bash
# Read-only checks + rollback proof in PGlite: fixture -> live-before -> migrations -> post-apply-checks -> use the functions
# -> rollbacks (350 then 300) -> rollback-check -> rollbacks again (re-appliable) -> re-apply -> post-apply-checks.
H=$(cd "$(dirname "$0")" && pwd); R=$(cd "$H/../../../.." && pwd); V=$R/docs/validation/VTID-05493; M=$R/supabase/migrations
node "$H/checks.mjs" "$H/base_schema.sql" "$M/20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql" "$V/pgtap/vtid_05493_fixture.sql" \
  "$V/live-before.sql" \
  "$M"/20261102070300_vtid_*_mt_tenant_deactivate.sql "$M"/20261102070350_vtid_*_mt_tenant_archive_switch.sql \
  "$V/post-apply-checks.sql" "$H/rollback-exercise.sql" \
  "$V/rollback-070350-tenant-archive-switch.sql" "$V/rollback-070300-tenant-deactivate.sql" \
  "$V/rollback-check.sql" "$H/rollback-state.sql" \
  "$V/rollback-070350-tenant-archive-switch.sql" 2>&1
