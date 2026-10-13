-- =============================================================================
-- VTID-05038 — Restore "Alle Beisammen" auto-enrollment for new members
-- =============================================================================
-- VOA plan v3 §3 item 1 (docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md).
--
-- 20260917084341_vtid_03990 re-created fire_welcome_chat_on_membership() from
-- the pre-Alle-Beisammen body (20260601000000_VTID_03089) and so silently
-- reverted 20260625000000_alle_beisammen_chat_group.sql:
--   * system-group enrollment sat after the `welcome_chat_sent` and
--     `> 1000 recipients` early returns again;
--   * the per-group cap was a hard-coded `< 100` again instead of
--     chat_groups.metadata->>'cap' (NULL = uncapped).
-- Measured read-only 2026-10-10: every real member who joined between
-- 2026-09-17 and 2026-10-06 (12 people) is missing from "Alle Beisammen 🤗"
-- (metadata.cap = null). "🎆 FIRST 100" is full and stays capped.
--
-- This migration, in one transaction (both land or neither):
--   0. Refuses to run unless the live function is still exactly the VTID-03990
--      shape it was written against (or already this migration's body — a
--      re-run) — a change made since then outside migrations gets reviewed,
--      not overwritten.
--   1. Re-creates the function = the VTID-03990 body with three changes:
--        a) the account guard covers service_bot_accounts AND
--           notification_test_actors (CLAUDE.md rules 43/45);
--        b) system-group enrollment runs before both early returns;
--        c) the cap is metadata-driven (NULL = uncapped).
--      The welcome DM text, recipients and metadata are unchanged.
--   2. Backfills the missing primary members into their tenant's UNCAPPED
--      system groups only, excluding both allowlists and the bot. No trigger
--      exists on chat_group_members, so this sends nothing to anyone.
-- =============================================================================

BEGIN;

-- 0) Pre-check: the live body must still be the VTID-03990 version.
DO $$
DECLARE
  v_src TEXT;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
   WHERE p.oid = 'public.fire_welcome_chat_on_membership()'::regprocedure;

  -- Already this migration's body (a re-run): fine, everything below is idempotent.
  IF v_src IS NOT NULL AND position('VTID-05038 (restores Alle Beisammen)' IN v_src) > 0 THEN
    RETURN;
  END IF;

  IF v_src IS NULL
     OR position('service_bot_accounts' IN v_src) = 0
     OR position('< 100' IN v_src) = 0
     OR position('metadata->>''cap''' IN v_src) > 0 THEN
    RAISE EXCEPTION 'VTID-05038: fire_welcome_chat_on_membership() is not the VTID-03990 body this migration was written against — review the live definition before re-applying';
  END IF;
END $$;

-- 1) The function.
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

  -- VTID-03990 + VTID-05038: never broadcast on behalf of, and never enrol, a
  -- registered service/automation or test account (both allowlists). Mark it
  -- sent so a later retry can't re-trigger this, then bail out before touching
  -- chat_messages or chat_group_members.
  IF EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = v_user_id)
     OR EXISTS (SELECT 1 FROM public.notification_test_actors WHERE user_id = v_user_id) THEN
    UPDATE public.app_users SET welcome_chat_sent = true WHERE user_id = v_user_id;
    RAISE NOTICE '[welcome_chat_trigger] % is a registered service/test account, skipping fan-out and enrollment', v_user_id;
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

  -- VTID-05038 (restores Alle Beisammen): auto-enrol in every system chat
  -- group in this tenant. The per-group cap is metadata-driven:
  -- metadata->>'cap' NULL = uncapped ("Alle Beisammen 🤗"), a number = capped
  -- ("🎆 FIRST 100" = 100). Runs BEFORE the early returns below, so every
  -- primary member is enrolled regardless of community size or whether the
  -- welcome DM fan-out already happened. ON CONFLICT keeps re-runs safe.
  INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role)
  SELECT g.id, v_user_id, v_tenant_id, 'member'
    FROM public.chat_groups g
   WHERE g.tenant_id = v_tenant_id
     AND g.is_system = true
     AND (
       (g.metadata->>'cap') IS NULL
       OR (SELECT COUNT(*) FROM public.chat_group_members m WHERE m.group_id = g.id)
            < (g.metadata->>'cap')::int
     )
  ON CONFLICT (group_id, user_id) DO NOTHING;

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
  'VTID-03089 + Alle Beisammen + VTID-03990 + VTID-05038: skips registered service/test accounts (service_bot_accounts, notification_test_actors); enrolls every other new primary member in all is_system chat groups (metadata-driven cap, uncapped when metadata.cap is NULL) BEFORE the early returns; then sends the welcome chat fan-out. Idempotent via app_users.welcome_chat_sent (DM fan-out only) and ON CONFLICT (enrollment).';

-- 2) Backfill the members the reverted body skipped — uncapped groups only.
DO $$
DECLARE
  v_missing INT;
  v_added   INT;
BEGIN
  SELECT COUNT(*) INTO v_missing
    FROM public.user_tenants ut
    JOIN public.chat_groups g
      ON g.tenant_id = ut.tenant_id AND g.is_system = true AND (g.metadata->>'cap') IS NULL
   WHERE ut.is_primary = true
     AND ut.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = ut.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors n WHERE n.user_id = ut.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.chat_group_members m WHERE m.group_id = g.id AND m.user_id = ut.user_id);

  IF v_missing > 200 THEN
    RAISE EXCEPTION 'VTID-05038: backfill would add % memberships (> 200) — refusing; check the population', v_missing;
  END IF;

  INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role)
  SELECT g.id, ut.user_id, ut.tenant_id, 'member'
    FROM public.user_tenants ut
    JOIN public.chat_groups g
      ON g.tenant_id = ut.tenant_id AND g.is_system = true AND (g.metadata->>'cap') IS NULL
   WHERE ut.is_primary = true
     AND ut.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = ut.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors n WHERE n.user_id = ut.user_id)
  ON CONFLICT (group_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RAISE NOTICE 'VTID-05038: backfilled % uncapped system-group memberships (expected % missing)', v_added, v_missing;
END $$;

COMMIT;
