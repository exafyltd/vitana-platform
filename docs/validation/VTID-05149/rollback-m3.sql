-- VTID-05149 rollback R3: drop public.ci_tenant_isolation_health() (undoes M3,
-- 20261014000300). Independent of R1/R2. Morning row 21b then reports
-- "RPC HTTP 404" as INFO; nothing pages.

BEGIN;
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.ci_tenant_isolation_health();
COMMIT;
