-- VTID-05579 rollback of 20261102054200 (run first). Restores the two read policies to the 20260522010000 form (membership through
-- is_chat_group_member(), auth.uid() evaluated per row). Creates no other policy; the allow-all catch-alls stay gone
-- (20260608120000:26-27).
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP POLICY IF EXISTS chat_groups_member_read ON public.chat_groups;
CREATE POLICY chat_groups_member_read ON public.chat_groups FOR SELECT
  USING (public.is_chat_group_member(chat_groups.id, auth.uid()));
DROP POLICY IF EXISTS chat_group_members_read ON public.chat_group_members;
CREATE POLICY chat_group_members_read ON public.chat_group_members FOR SELECT
  USING (public.is_chat_group_member(chat_group_members.group_id, auth.uid()));
COMMIT;
