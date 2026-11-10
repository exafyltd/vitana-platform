-- VTID-05576 (mt-network-r2/messaging-send-db) N1c, contract: chat_messages gets no client writes except a read marker.
--
-- After this file a message is written only by send_message() / send_message_as() (SECURITY DEFINER, owner bypasses RLS) and by
-- the allowlisted system writers, which must send scope = 'community' explicitly:
--   1. DROP DEFAULT on chat_messages.scope (the contract half of 20261102050000): an insert that names no scope fails 23502.
--   2. ASSERT the catch-all service_role_manage_chat policy stays gone (created 20260225200000_chat_messages.sql:35-38, already
--      dropped by 20260608120000_phase_a_security_hotfix.sql:25). The DROP POLICY IF EXISTS below is a no-op on a healthy
--      database; if a policy named so, or any allow-all policy, is present afterwards the file raises and rolls back.
--   3. Replace the client policies with narrow ones, evaluated once per statement via (select auth.uid()):
--        chat_messages_participant_read  SELECT  sender or receiver (replaces users_read_own_messages);
--        chat_messages_recipient_mark_read  UPDATE  receiver only (replaces users_mark_received_read);
--      users_read_group_messages (group members read) is kept. The INSERT policies users_send_messages and
--      users_send_group_messages are dropped.
--   4. REVOKE INSERT, UPDATE on chat_messages from PUBLIC, anon, authenticated, then GRANT UPDATE (read_at, delivered_at) to
--      authenticated: a recipient can mark read, never rewrite content, scope or tenant.
-- service_role keeps its table privileges (system writers: /vitana-reply, welcome-chat, companion, proactive-match); the scope
-- guard from 20261102050000 stops it writing scope = 'network' or changing a scope. No bare current_tenant_id() policy is added.
-- APPLY ONLY AFTER messaging-send-gateway is deployed: until the gateway sends scope on every insert and routes member sends
-- through the RPCs, step 1 and step 4 would make today's writers fail.
-- Rollback: docs/validation/VTID-05576/rollback-050200-chat-messages-lockdown.sql.

-- impact-allow-solo-migration: tightens one table's grants and policies; the writers it requires ship in messaging-send-gateway.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.chat_messages ALTER COLUMN scope DROP DEFAULT;

DROP POLICY IF EXISTS service_role_manage_chat ON public.chat_messages;

DROP POLICY IF EXISTS users_read_own_messages ON public.chat_messages;
DROP POLICY IF EXISTS chat_messages_participant_read ON public.chat_messages;
CREATE POLICY chat_messages_participant_read ON public.chat_messages FOR SELECT
  USING ((SELECT auth.uid()) = sender_id OR (SELECT auth.uid()) = receiver_id);

DROP POLICY IF EXISTS users_mark_received_read ON public.chat_messages;
DROP POLICY IF EXISTS chat_messages_recipient_mark_read ON public.chat_messages;
CREATE POLICY chat_messages_recipient_mark_read ON public.chat_messages FOR UPDATE
  USING ((SELECT auth.uid()) = receiver_id)
  WITH CHECK ((SELECT auth.uid()) = receiver_id);

DROP POLICY IF EXISTS users_send_messages ON public.chat_messages;
DROP POLICY IF EXISTS users_send_group_messages ON public.chat_messages;

REVOKE INSERT, UPDATE ON TABLE public.chat_messages FROM PUBLIC, anon, authenticated;
GRANT UPDATE (read_at, delivered_at) ON TABLE public.chat_messages TO authenticated;

DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'chat_messages'
                AND (policyname = 'service_role_manage_chat' OR cmd = 'ALL' OR cmd = 'INSERT'
                     OR qual = 'true' OR with_check = 'true')) THEN
    RAISE EXCEPTION 'VTID-05576: chat_messages still has an allow-all, ALL-command or INSERT policy' USING ERRCODE = 'P0001';
  END IF;
END
$mig$;

COMMIT;
