-- VTID-05573 rollback of 20261102052100 (run THIRD, after rollback-052200). Drops the four migration functions.
BEGIN;
DROP FUNCTION IF EXISTS public.mt_legacy_messages_assert_ready();
DROP FUNCTION IF EXISTS public.mt_legacy_messages_migrate();
DROP FUNCTION IF EXISTS public.mt_legacy_context_tenant(uuid);
DROP FUNCTION IF EXISTS public.mt_legacy_common_tenant(uuid[]);
COMMIT;
