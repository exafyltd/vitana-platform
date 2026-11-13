-- VTID-05623: welcome-chat trigger must skip service/automation and test accounts
-- (rule 43/44: registered service_bot_accounts and notification_test_actors never get a
-- welcome broadcast or group enrolment). Restores the intended body from VTID-03990 + VTID-05038.
-- Supersedes VTID-05038 (not applied as written: the live body differed, see docs/validation/VTID-05623).
-- CREATE OR REPLACE only: no table, data or trigger change. Idempotent.
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
