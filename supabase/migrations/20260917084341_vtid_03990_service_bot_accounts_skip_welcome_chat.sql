-- =============================================================================
-- VTID-03990 — Guard the VTID-03089 welcome-chat broadcast against
-- service/automation accounts.
-- =============================================================================
-- Incident: on 2026-09-16 11:38 UTC two service/automation identities
-- (claude-code-agent@exafy.io, operator-autopilot@exafy.io) were provisioned
-- directly into `user_tenants` as primary tenant members. Neither is the
-- Vitana bot user, so `fire_welcome_chat_on_membership()` (VTID-03089) ran
-- normally and fanned an identical "Hello! My name is ... I just joined the
-- community" DM out to every other member of the tenant — 222 and 223 real
-- recipients respectively, within milliseconds of each account's creation.
--
-- Fix: a small, explicit, auditable allowlist of accounts that must NEVER be
-- treated as a real community member for automated fan-out purposes, checked
-- the same way the existing hardcoded Vitana-bot check already is. New
-- entries are added by inserting a row, not by redeploying code — mirroring
-- the `notification_test_actors` pattern already used in the community-app
-- repo (exafyltd/vitana-v1, migration 20260805160000) for the equivalent
-- test-actor-notification problem.
--
-- This does not touch the welcome-chat feature for real new members — it
-- only ever skips accounts explicitly registered here.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.service_bot_accounts (
  user_id    UUID PRIMARY KEY,
  label      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.service_bot_accounts ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (which bypasses RLS) may read/write this
-- table. It is consulted exclusively from SECURITY DEFINER functions and
-- gateway code running with the service role key, never from the client.

COMMENT ON TABLE public.service_bot_accounts IS
  'VTID-03990: allowlist of user_ids that are service/automation identities, '
  'not real community members. Checked by fire_welcome_chat_on_membership() '
  '(and its TS mirror, sendWelcomeChatMessages) so a service/test account can '
  'never trigger a tenant-wide chat broadcast. Add a row to exempt a new '
  'account; do not redeploy code for that.';

INSERT INTO public.service_bot_accounts (user_id, label, reason) VALUES
  ('887b34cb-9ee9-47dc-ad53-db5be1869846', 'claude-code-agent',
   'VTID-03990: automation identity provisioned 2026-09-16 11:38:38 UTC; '
   'its primary-membership insert fanned out 222 real welcome-chat DMs '
   'before this guard existed.'),
  ('856c30ed-7136-4bc5-8bfe-86a1e8ea1401', 'operator-autopilot',
   'VTID-03990: automation identity provisioned 2026-09-16 11:38:40 UTC; '
   'its primary-membership insert fanned out 223 real welcome-chat DMs '
   'before this guard existed.')
ON CONFLICT (user_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Re-point the VTID-03089 trigger function to skip anything in the new
-- allowlist, in addition to the existing hardcoded bot-user check. The
-- trigger itself (`welcome_chat_on_primary_membership` on `user_tenants`)
-- is unchanged — only the function body it calls is replaced.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fire_welcome_chat_on_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_bot          UUID := '00000000-0000-0000-0000-000000000001';
  v_user_id      UUID := NEW.user_id;
  v_tenant_id    UUID := NEW.tenant_id;
  v_app_user     RECORD;
  v_display_name TEXT;
  v_message      TEXT;
  v_recipient    INT;
  v_inserted     INT;
BEGIN
  IF NEW.is_primary IS NOT TRUE THEN RETURN NEW; END IF;
  IF v_user_id = v_bot          THEN RETURN NEW; END IF;

  -- VTID-03990: never broadcast on behalf of a registered service/
  -- automation account. Mark it sent so a later retry can't re-trigger
  -- this once the row exists, then bail out before touching chat_messages.
  IF EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = v_user_id) THEN
    UPDATE public.app_users SET welcome_chat_sent = true WHERE user_id = v_user_id;
    RAISE NOTICE '[welcome_chat_trigger] % is a registered service/automation account, skipping fan-out', v_user_id;
    RETURN NEW;
  END IF;

  -- app_users may be inserted after user_tenants in some provisioning flows.
  -- If missing, skip silently — a follow-up insert (or backfill) will pick
  -- the user up. Better to do nothing than to send a "a new member" greeting
  -- with no name.
  SELECT user_id, display_name, COALESCE(welcome_chat_sent, false) AS welcome_chat_sent, vitana_id
    INTO v_app_user
    FROM public.app_users
   WHERE user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE NOTICE '[welcome_chat_trigger] app_users row missing for %, skipping', v_user_id;
    RETURN NEW;
  END IF;

  IF v_app_user.welcome_chat_sent THEN
    RETURN NEW;
  END IF;

  v_display_name := COALESCE(NULLIF(TRIM(v_app_user.display_name), ''), 'a new member');

  -- Recipient count = primary tenant members minus self minus bot.
  SELECT COUNT(*) INTO v_recipient
    FROM public.user_tenants ut
   WHERE ut.tenant_id = v_tenant_id
     AND ut.user_id <> v_user_id
     AND ut.user_id <> v_bot;

  -- 0 members or oversized community: still mark sent so we never retry.
  IF v_recipient = 0 OR v_recipient > 1000 THEN
    UPDATE public.app_users SET welcome_chat_sent = true WHERE user_id = v_user_id;
    RAISE NOTICE '[welcome_chat_trigger] tenant % has % recipients for %, marking sent without fan-out',
      v_tenant_id, v_recipient, v_user_id;
    RETURN NEW;
  END IF;

  v_message := 'Hello! My name is ' || v_display_name
            || ' — I just joined the community and I''m excited to connect with you! 🙌';

  WITH inserted AS (
    INSERT INTO public.chat_messages (
      tenant_id, sender_id, receiver_id, content, message_type, metadata,
      sender_vitana_id, receiver_vitana_id
    )
    SELECT
      v_tenant_id,
      v_user_id,
      ut.user_id,
      v_message,
      'text',
      jsonb_build_object(
        'source',     'welcome_chat',
        'automated',   true,
        'trigger',    'db_trigger_on_membership',
        'trigger_vtid','VTID-03089'
      ),
      v_app_user.vitana_id,
      (SELECT au.vitana_id FROM public.app_users au WHERE au.user_id = ut.user_id)
    FROM public.user_tenants ut
    WHERE ut.tenant_id = v_tenant_id
      AND ut.user_id <> v_user_id
      AND ut.user_id <> v_bot
    RETURNING id
  )
  SELECT COUNT(*) INTO v_inserted FROM inserted;

  UPDATE public.app_users SET welcome_chat_sent = true WHERE user_id = v_user_id;

  -- Auto-enrol in every system chat group in this tenant, capped at 100
  -- members per group ("🎆 FIRST 100"). ON CONFLICT keeps re-runs safe.
  INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role)
  SELECT g.id, v_user_id, v_tenant_id, 'member'
    FROM public.chat_groups g
   WHERE g.tenant_id = v_tenant_id
     AND g.is_system = true
     AND (SELECT COUNT(*) FROM public.chat_group_members m WHERE m.group_id = g.id) < 100
  ON CONFLICT (group_id, user_id) DO NOTHING;

  RAISE NOTICE '[welcome_chat_trigger] fired for % in tenant %: % messages sent, groups enrolled',
    v_user_id, v_tenant_id, v_inserted;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Never block the user_tenants insert. Surface to logs for ops.
    RAISE WARNING '[welcome_chat_trigger] FAILED for user % tenant %: % / %',
      v_user_id, v_tenant_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fire_welcome_chat_on_membership() IS
  'VTID-03089/VTID-03990: Sends welcome chat messages + enrolls user in system groups on primary tenant membership insert. Skips registered service/automation accounts (service_bot_accounts) and the Vitana bot user.';
