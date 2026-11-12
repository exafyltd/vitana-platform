-- VTID-05495 rollback: drops the one table the migration created. Safe only while nothing publishes into it
-- (no reader or writer exists in this spec; mt-launch rows 9-10 must be rolled back first, they depend on it).
-- Owner approval required before it is applied anywhere (collaboration.md section 7d).
BEGIN;
DROP TABLE IF EXISTS public.tenant_content_overrides;
COMMIT;
