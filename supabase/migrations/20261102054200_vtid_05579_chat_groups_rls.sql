-- VTID-05579 (mt-network-r2/network-groups-db) M3c: participant-only RLS on chat_groups and chat_group_members.
--
-- Network groups are visible to their participants only, and so is their member list. The two read policies already test
-- membership through the recursion-free helper is_chat_group_member() (20260522010000); this file restates them in the
-- once-per-statement form, so the planner evaluates auth.uid() one time per statement instead of once per row:
--   chat_groups_member_read          SELECT  is_chat_group_member(id, (SELECT auth.uid()))
--   chat_group_members_read          SELECT  is_chat_group_member(group_id, (SELECT auth.uid()))
-- The same predicate covers both scopes: a community group and a network group are read by their participants only; the
-- tenant, which is only context for a network group, never opens a row.
-- There is NO policy for INSERT, UPDATE, DELETE or ALL, and none is added: a client write is denied by RLS, and the rows are
-- written by service_role (which bypasses RLS) and by the SECURITY DEFINER functions of 20261102054100. The allow-all
-- catch-alls chat_groups_service_role / chat_group_members_service_role (20260525000000:78-98, FOR ALL USING (true)) were dropped
-- by 20260608120000:26-27; the DROP POLICY IF EXISTS below is a no-op on a healthy database, and if any allow-all policy
-- (USING true / WITH CHECK true, or a command other than SELECT) exists on the two tables afterwards the file raises and rolls back.
-- No bare current_tenant_id() policy is added. Grants are not changed.
-- Rollback: docs/validation/VTID-05579/rollback-054200-chat-groups-rls.sql (restores the 20260522010000 form).

-- impact-allow-solo-migration: restates two read policies and asserts that no allow-all policy exists; no writer or reader changes.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP POLICY IF EXISTS chat_groups_service_role ON public.chat_groups;
DROP POLICY IF EXISTS chat_group_members_service_role ON public.chat_group_members;

DROP POLICY IF EXISTS chat_groups_member_read ON public.chat_groups;
CREATE POLICY chat_groups_member_read ON public.chat_groups FOR SELECT
  USING (public.is_chat_group_member(chat_groups.id, (SELECT auth.uid())));

DROP POLICY IF EXISTS chat_group_members_read ON public.chat_group_members;
CREATE POLICY chat_group_members_read ON public.chat_group_members FOR SELECT
  USING (public.is_chat_group_member(chat_group_members.group_id, (SELECT auth.uid())));

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename IN ('chat_groups', 'chat_group_members')
                AND (cmd <> 'SELECT' OR qual = 'true' OR with_check = 'true'
                     OR policyname IN ('chat_groups_service_role', 'chat_group_members_service_role'))) THEN
    RAISE EXCEPTION 'VTID-05579: chat_groups or chat_group_members still has an allow-all or non-SELECT policy' USING ERRCODE = 'P0001';
  END IF;
END
$mig$;

COMMIT;
