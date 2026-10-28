# VTID-05324 acceptance (mt-launch/pack-intake-db, tasks.md P1-P5)

AC-1 `tenant_pack_intake`: PK `(tenant_id, item_key)`, item_key + status CHECKs, service-role-only RLS, expand-only, no backfill.
TEST: npx jest test/mt-launch-pack-intake-pgtap.test.ts -t "P1 tenant_pack_intake|service-role-only|expand-only"

AC-2 `tenant_content_pipeline`: `unique (tenant_id, locale, key)`, review_state CHECK, service-role-only RLS.
TEST: npx jest test/mt-launch-pack-intake-pgtap.test.ts -t "P2 tenant_content_pipeline|service-role-only"

AC-3 `get_tenant_launch_readiness(p_tenant_id)`: SECURITY INVOKER, STABLE, `SET search_path = public, pg_catalog`, EXECUTE revoked from PUBLIC/anon/authenticated and granted to service_role, reads only intake + `tenants`, no health table.
TEST: npx jest test/mt-launch-pack-intake-pgtap.test.ts -t "P3 get_tenant_launch_readiness"

AC-4 MIGRATION-QUEUE rows for both files after WS5 `tenant_content_overrides`, with rollback + pre/post checks; both tables in the drift baseline.
TEST: npx jest test/mt-launch-pack-intake-pgtap.test.ts -t "P4 queue"
TEST: node --test scripts/ci/check-migration-drift.test.cjs

AC-5 A non-service-role read of either table fails; the readiness function is read-only and returns for maxina; renumber if a later migration exists; rollback SQL present.
TEST: npx jest test/mt-launch-pack-intake-pgtap.test.ts (17/17; pgTAP twin pgtap-pack-intake.sql for a throwaway DB)
