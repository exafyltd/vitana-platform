-- VTID-04971 — provisioning and reset of the OpenAI reviewer sandbox account.
--
-- OWNER-RUN. Nothing in this repository runs this file. It writes to the one
-- (production) Supabase project, so it is an explicit production write that the
-- owner (or a session the owner instructs) runs, on purpose, in this order.
--
-- WHY THE ORDER MATTERS: the moment the auth user exists, the on_auth_user_platform_provision
-- trigger gives it a PRIMARY membership in the community tenant, and the membership triggers
-- (welcome-chat DM to every member, founding seat, ...) fire in the same transaction. The
-- exclusion rows must therefore exist BEFORE the user does (platform CLAUDE.md rules 43-45).
--
-- PHASE 1 (before the user exists) ------------------------------------------------------
-- Pick the id once and keep it. Replace the e-mail with the reviewer address; an address on
-- @vitanatest.exafy.io also satisfies the notification guard's e-mail pattern (extra safety;
-- the table rows below are still required).
\set reviewer_id '00000000-0000-0000-0000-000000000000'   -- <-- REPLACE with gen_random_uuid() output, once

BEGIN;
INSERT INTO public.service_bot_accounts (user_id, label, reason)
VALUES (:'reviewer_id', 'openai-reviewer', 'VTID-04971: OpenAI plugin review sandbox account; must never reach members')
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO public.notification_test_actors (user_id, reason)
VALUES (:'reviewer_id', 'VTID-04971: OpenAI plugin review sandbox account')
ON CONFLICT (user_id) DO NOTHING;
COMMIT;

-- PHASE 2 (create the user) ---------------------------------------------------------------
-- Create the Supabase auth user WITH THAT ID (Auth admin API createUser accepts "id"):
--   email: reviewer@vitanatest.exafy.io (confirmed), a strong password, NO second factor
--   (OpenAI rejects review accounts that need sign-up or 2FA). Hand the credentials to OpenAI
--   only in the portal's "Review details" form, never in the plugin package or the repository.

-- PHASE 3 (after the user exists) ---------------------------------------------------------
-- 3a. The membership trigger gave the account an idle personal live room in the community
--     tenant. Remove it so no member surface lists it.
BEGIN;
UPDATE public.app_users SET live_room_id = NULL WHERE user_id = :'reviewer_id';
DELETE FROM public.live_rooms WHERE host_user_id = :'reviewer_id' AND status = 'idle';
COMMIT;

-- 3b. Checks (expect: both 1, welcome DMs 0, profile hidden, no live room).
SELECT (SELECT count(*) FROM public.service_bot_accounts WHERE user_id = :'reviewer_id') AS in_service_bots,
       (SELECT count(*) FROM public.notification_test_actors WHERE user_id = :'reviewer_id') AS in_test_actors,
       (SELECT count(*) FROM public.chat_messages WHERE sender_id <> :'reviewer_id'
          AND created_at > now() - interval '1 hour'
          AND chat_id IN (SELECT chat_id FROM public.chat_members WHERE user_id = :'reviewer_id')) AS welcome_style_dms_to_reviewer,
       (SELECT count(*) FROM public.live_rooms WHERE host_user_id = :'reviewer_id') AS live_rooms;
-- (adjust the chat_* table names to the live schema if they differ; the intent is "no
--  welcome DM was sent to or from this account")

-- 3c. Also confirm the profile is hidden from the member directory:
SELECT is_visible FROM public.global_community_profiles WHERE user_id = :'reviewer_id';   -- expect false

-- RESET (between reviews or after the review) -----------------------------------------------
-- Everything the reviewer wrote belongs to organizations OWNED by that account. Run it first
-- inside BEGIN ... ROLLBACK to read the row counts and the FK behaviour, then COMMIT.
-- BEGIN;
--   DELETE FROM public.products
--    WHERE merchant_id IN (SELECT m.id FROM public.merchants m
--                           JOIN public.partner_organizations o ON o.id = m.partner_organization_id
--                          WHERE o.owner_user_id = :'reviewer_id');
--   DELETE FROM public.merchants
--    WHERE partner_organization_id IN (SELECT id FROM public.partner_organizations WHERE owner_user_id = :'reviewer_id');
--   DELETE FROM public.partner_organizations WHERE owner_user_id = :'reviewer_id';
--   -- members, steps, terms acceptances and tenants cascade or must be deleted by organization id
--   -- if the live FKs do not cascade: check the ROLLBACK run's error output.
-- COMMIT;
