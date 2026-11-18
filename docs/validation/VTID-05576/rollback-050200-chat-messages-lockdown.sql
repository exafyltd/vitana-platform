-- VTID-05576 rollback of 20261102050200 (run first). Restores the pre-lockdown state of chat_messages: the scope DEFAULT, the
-- three original client policies, and INSERT/UPDATE for authenticated. service_role_manage_chat is NOT recreated (it was dropped
-- by 20260608120000 before this lane and must stay gone). Idempotent.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.chat_messages ALTER COLUMN scope SET DEFAULT 'community';

DROP POLICY IF EXISTS chat_messages_participant_read ON public.chat_messages;
DROP POLICY IF EXISTS chat_messages_recipient_mark_read ON public.chat_messages;

DROP POLICY IF EXISTS users_read_own_messages ON public.chat_messages;
CREATE POLICY users_read_own_messages ON public.chat_messages FOR SELECT
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
DROP POLICY IF EXISTS users_send_messages ON public.chat_messages;
CREATE POLICY users_send_messages ON public.chat_messages FOR INSERT
  WITH CHECK (auth.uid() = sender_id);
DROP POLICY IF EXISTS users_mark_received_read ON public.chat_messages;
CREATE POLICY users_mark_received_read ON public.chat_messages FOR UPDATE
  USING (auth.uid() = receiver_id) WITH CHECK (auth.uid() = receiver_id);
DROP POLICY IF EXISTS users_send_group_messages ON public.chat_messages;
CREATE POLICY users_send_group_messages ON public.chat_messages FOR INSERT
  WITH CHECK (group_id IS NOT NULL AND auth.uid() = sender_id AND public.is_chat_group_member(chat_messages.group_id, auth.uid()));

GRANT INSERT, UPDATE ON TABLE public.chat_messages TO authenticated;
COMMIT;
