-- VTID-05506 rollback of 20261102141100_vtid_05506_mt_isolation_health_by_tenant.sql: drops the per-tenant function.
-- ci_tenant_isolation_health() (VTID-05149) is untouched by the lane and by this rollback. The function holds no data and
-- nothing else depends on it until the gateway lane monitoring-erp-gw ships. Idempotent.
-- Not under supabase/migrations/: a *_rollback.sql file there shares the forward file's version and sorts after it.
-- Run order: this file first, then rollback-141000-provision-erp-request.sql. Run rollback-check.sql afterwards (read-only).
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.ci_tenant_isolation_health_by_tenant();
COMMIT;
