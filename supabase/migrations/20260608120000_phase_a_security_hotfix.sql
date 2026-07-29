-- PHASE A EMERGENCY SECURITY HOTFIX  (2026-06-08)
-- Context: the public anon key (shipped in web/mobile bundles) could read 104 tables and
-- WRITE 76 tables via PostgREST, including forging wallet/ledger/stripe rows, tampering with
-- audit logs, and forging chat messages. Two root causes:
--   (1) buggy "TO public USING(true)" policies meant for service_role (which bypasses RLS anyway),
--   (2) Supabase default write grants to the anon role never revoked.
-- This migration closes the WRITE vectors. Scoped user policies (auth.uid() = ...) are left intact,
-- so logged-in apps are unaffected. The gateway is unaffected (service_role bypasses RLS).
-- Read-side exposure on the 42 RLS-disabled tables is handled separately in Phase B.

BEGIN;

-- 1) FINANCIAL / PAYMENT: drop allow-all write policies (scoped "Users read own ..." remain) -------
DROP POLICY IF EXISTS "Service role manage wallet accounts"       ON public.wallet_accounts;
DROP POLICY IF EXISTS "Service role manage deposits"              ON public.wallet_deposits;
DROP POLICY IF EXISTS "Service role manage ledger entries"        ON public.wallet_ledger_entries;
DROP POLICY IF EXISTS "Service role manage stripe_webhook_events" ON public.stripe_webhook_events;
DROP POLICY IF EXISTS "System can update checkout sessions"       ON public.checkout_sessions;
DROP POLICY IF EXISTS "System can insert purchases"               ON public.event_ticket_purchases;
DROP POLICY IF EXISTS "System can update purchases"               ON public.event_ticket_purchases;
DROP POLICY IF EXISTS "Users can create purchases"                ON public.package_purchases; -- unscoped dup; "...in their tenant" remains
DROP POLICY IF EXISTS "System can update purchases"               ON public.package_purchases;

-- 2) MESSAGING: drop allow-all service policies (scoped send/read-own siblings remain) -------------
DROP POLICY IF EXISTS "service_role_manage_chat"            ON public.chat_messages;
DROP POLICY IF EXISTS "chat_groups_service_role"           ON public.chat_groups;
DROP POLICY IF EXISTS "chat_group_members_service_role"    ON public.chat_group_members;
DROP POLICY IF EXISTS "conversation_messages_service_role" ON public.conversation_messages;
DROP POLICY IF EXISTS "service_role_manage_invitations"    ON public.community_group_invitations;
DROP POLICY IF EXISTS "Service role can insert messages"   ON public.ai_messages;

-- 3) IDENTITY / DEVICE / NOTIFICATION: drop allow-all (scoped users_*_own siblings remain) --------
DROP POLICY IF EXISTS "service_role_manage_tokens"              ON public.user_device_tokens;
DROP POLICY IF EXISTS "service_role_full_access_category_prefs" ON public.user_category_preferences;
DROP POLICY IF EXISTS "service_role_insert_notifications"       ON public.user_notifications;

-- 4) AUDIT / LOG (server-only writes): drop allow-all insert policies -------------------------------
DROP POLICY IF EXISTS "audit_events_insert_any"            ON public.audit_events;
DROP POLICY IF EXISTS "System can insert notification logs" ON public.notification_logs;
DROP POLICY IF EXISTS "System inserts search audit"        ON public.search_audit_log;

-- 5) Revoke ALL write privileges from the anon role (never-logged-in must never write) -------------
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM anon;

-- 6) Re-grant the three intentional anonymous write flows -------------------------------------------
GRANT INSERT ON public.test_user_applications TO anon; -- public "apply to be a tester" form
GRANT INSERT ON public.media_analytics        TO anon; -- anonymous media analytics ingestion
GRANT INSERT ON public.media_events           TO anon; -- anonymous media event ingestion

-- 7) RLS-disabled server-only financial/identity tables: revoke writes from clients ----------------
REVOKE INSERT, UPDATE, DELETE ON public.service_payments   FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.vitana_id_reserved FROM anon, authenticated;

COMMIT;
