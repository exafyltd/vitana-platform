-- VTID-05579 rollback of 20261102054100 (run second, after rollback-054200). Drops the six functions, the callers first.
-- Network groups and members already created stay as they are (rollback-054000 refuses while any of them exists).
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.add_group_member_as(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.create_network_group_as(uuid, text, text);
DROP FUNCTION IF EXISTS public.add_group_member(uuid, uuid);
DROP FUNCTION IF EXISTS public.create_network_group(text, text);
DROP FUNCTION IF EXISTS public.chat_group_add_member_core(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.chat_group_create_core(uuid, text, text);
COMMIT;
