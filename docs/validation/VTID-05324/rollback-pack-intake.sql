-- VTID-05324 rollback (mt-launch/pack-intake-db). Expand-only migrations, so this is safe:
-- it removes only the objects 20261101110000 + 20261101110100 created, in reverse order.
-- Applied by Claude via RUN-MIGRATION only, never from a session. Any rows in the two tables are lost
-- (they hold only WS8 intake/pipeline state; nothing else references them).
BEGIN;
DROP FUNCTION IF EXISTS public.get_tenant_launch_readiness(uuid);
DROP TABLE IF EXISTS public.tenant_content_pipeline;
DROP TABLE IF EXISTS public.tenant_pack_intake;
COMMIT;
