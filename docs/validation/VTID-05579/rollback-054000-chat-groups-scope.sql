-- VTID-05579 rollback of 20261102054000 (run last, after rollback-054200 and rollback-054100). Drops the three triggers, their
-- functions, the four CHECKs and the two scope columns. REFUSES (changes nothing) while
--   * the functions of 054100 still exist (roll them back first), or
--   * a network group that the functions created exists (scope = 'network' without metadata.legacy_scope = 'network'): dropping the
--     column would turn a cross-tenant group into an ordinary tenant group of its creator's tenant. Move or archive it first.
-- The legacy cross-tenant groups of VTID-05573 keep metadata.legacy_scope = 'network', so a later re-apply classifies them again.
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $rb$
BEGIN
  IF to_regprocedure('public.add_group_member(uuid,uuid)') IS NOT NULL OR to_regprocedure('public.create_network_group(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05579 rollback refused: roll back 054100 (the functions) first' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'chat_groups' AND column_name = 'scope')
     AND EXISTS (SELECT 1 FROM public.chat_groups WHERE scope = 'network' AND coalesce(metadata ->> 'legacy_scope', '') <> 'network') THEN
    RAISE EXCEPTION 'VTID-05579 rollback refused: network groups created by create_network_group() exist; move or archive them first' USING ERRCODE = 'P0001';
  END IF;
END
$rb$;
DROP TRIGGER IF EXISTS trg_chat_group_members_scope_guard ON public.chat_group_members;
DROP TRIGGER IF EXISTS trg_chat_groups_scope_sync ON public.chat_groups;
DROP TRIGGER IF EXISTS trg_chat_groups_scope_guard ON public.chat_groups;
DROP FUNCTION IF EXISTS public.chat_group_members_scope_guard();
DROP FUNCTION IF EXISTS public.chat_groups_scope_sync();
DROP FUNCTION IF EXISTS public.chat_groups_scope_guard();
ALTER TABLE public.chat_group_members DROP CONSTRAINT IF EXISTS chat_group_members_network_no_bot;
ALTER TABLE public.chat_groups DROP CONSTRAINT IF EXISTS chat_groups_network_not_system;
ALTER TABLE public.chat_group_members DROP CONSTRAINT IF EXISTS chat_group_members_scope_check;
ALTER TABLE public.chat_groups DROP CONSTRAINT IF EXISTS chat_groups_scope_check;
ALTER TABLE public.chat_group_members DROP COLUMN IF EXISTS scope;
ALTER TABLE public.chat_groups DROP COLUMN IF EXISTS scope;
COMMIT;
