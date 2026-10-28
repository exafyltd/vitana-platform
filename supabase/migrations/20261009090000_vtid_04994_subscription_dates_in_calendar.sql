-- VTID-04994 — subscription renewal, trial end and Premium end dates show in the member's calendar.
--
-- user_subscriptions is the single source: Stripe-paid plans AND every grant
-- (redemption codes, founding_1000, launch auto-grant, earned time) write
-- their end date into current_period_end, so one trigger covers all of them.
--   * period entry  (source_ref_type 'subscription_period_end'): while the
--     subscription is active/trialing/past_due and the end is in the future.
--     metadata.kind = 'renews' for a Stripe subscription that will renew,
--     'ends' for a grant or a subscription set to cancel at period end.
--   * trial entry   (source_ref_type 'subscription_trial_end'): while trialing
--     and trial_end is in the future. metadata.kind = 'trial_ends'.
--   * moved when the dates change, cancelled when the subscription stops
--     being active, ends, or is deleted; a cancelled row is revived.
-- source_type 'subscription' (new). reminder_offsets = '{}': no push or
-- reminder is created from these entries (billing-adjacent pushes are a
-- product decision, not taken here). Titles are English fallbacks; the app
-- shows a localised title from metadata.kind.
-- The trigger function can never block a billing write: any error inside it
-- is caught and logged as a WARNING.
-- Test/service accounts are skipped. One-time backfill. Idempotent.
-- impact-allow-solo-migration: triggers + backfill on existing tables; the gateway type list and the frontend display ship in sibling PRs of the same VTID.

-- 1. Allow the new source type (recreate, keeping every existing value).
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.calendar_events'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%source_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.calendar_events DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_source_type
  CHECK (source_type IN (
    'manual', 'invite', 'imported', 'autopilot', 'community_rsvp', 'assistant',
    'journey', 'vtid', 'ci_cd', 'nudge_engine',
    'health_plan', 'lab_order', 'appointment', 'live_room', 'goal_plan', 'guided_journey',
    'reminder', 'subscription'
  ));

-- 2. One helper keeps a single calendar row in step with a wanted/unwanted state.
CREATE OR REPLACE FUNCTION public.fn_subscription_calendar_sync(
  p_user_id uuid, p_ref_id text, p_ref_type text,
  p_wanted boolean, p_when timestamptz, p_title text, p_kind text, p_plan text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT p_wanted THEN
    UPDATE public.calendar_events c
       SET status = 'cancelled', updated_at = now()
     WHERE c.user_id = p_user_id AND c.status <> 'cancelled'
       AND c.source_type = 'subscription' AND c.source_ref_type = p_ref_type
       AND c.source_ref_id = p_ref_id;
    RETURN;
  END IF;

  INSERT INTO public.calendar_events (
    user_id, title, start_time, end_time,
    event_type, source_type, source_ref_id, source_ref_type,
    status, role_context, reminder_offsets, metadata
  ) VALUES (
    p_user_id, p_title, p_when, p_when + interval '15 minutes',
    'personal', 'subscription', p_ref_id, p_ref_type,
    'confirmed', 'personal', '{}'::int[],
    jsonb_build_object('kind', p_kind, 'plan_key', p_plan, 'subscription_id', p_ref_id)
  )
  ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL
  DO UPDATE SET status = 'confirmed',
                title = EXCLUDED.title,
                start_time = EXCLUDED.start_time,
                end_time = EXCLUDED.end_time,
                metadata = EXCLUDED.metadata,
                updated_at = now();
END;
$function$;

-- 3. The trigger function: decides both entries for one subscription row.
CREATE OR REPLACE FUNCTION public.fn_subscription_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  s public.user_subscriptions%ROWTYPE;
  v_active boolean;
  v_kind text;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      PERFORM public.fn_subscription_calendar_sync(OLD.user_id, OLD.id::text, 'subscription_period_end', false, NULL, NULL, NULL, NULL);
      PERFORM public.fn_subscription_calendar_sync(OLD.user_id, OLD.id::text, 'subscription_trial_end',  false, NULL, NULL, NULL, NULL);
      RETURN OLD;
    END IF;

    s := NEW;
    IF EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = s.user_id)
       OR EXISTS (SELECT 1 FROM public.notification_test_actors WHERE user_id = s.user_id) THEN
      RETURN NEW;
    END IF;

    v_active := s.status IN ('active', 'trialing', 'past_due');
    v_kind := CASE WHEN s.stripe_subscription_id IS NOT NULL AND NOT s.cancel_at_period_end
                   THEN 'renews' ELSE 'ends' END;

    PERFORM public.fn_subscription_calendar_sync(
      s.user_id, s.id::text, 'subscription_period_end',
      v_active AND s.current_period_end IS NOT NULL AND s.current_period_end > now(),
      s.current_period_end,
      CASE WHEN v_kind = 'renews' THEN 'Premium renews' ELSE 'Premium ends' END,
      v_kind, s.plan_key);

    PERFORM public.fn_subscription_calendar_sync(
      s.user_id, s.id::text, 'subscription_trial_end',
      s.status = 'trialing' AND s.trial_end IS NOT NULL AND s.trial_end > now(),
      s.trial_end, 'Trial ends', 'trial_ends', s.plan_key);

    RETURN NEW;
  EXCEPTION WHEN OTHERS THEN
    -- Never block a billing write because the calendar mirror failed.
    RAISE WARNING 'fn_subscription_to_calendar failed: % (%)', SQLERRM, SQLSTATE;
    RETURN COALESCE(NEW, OLD);
  END;
END;
$function$;

DROP TRIGGER IF EXISTS trg_subscription_insert_calendar ON public.user_subscriptions;
CREATE TRIGGER trg_subscription_insert_calendar
  AFTER INSERT ON public.user_subscriptions
  FOR EACH ROW
  WHEN (NEW.status IN ('active', 'trialing', 'past_due'))
  EXECUTE FUNCTION public.fn_subscription_to_calendar();

DROP TRIGGER IF EXISTS trg_subscription_update_calendar ON public.user_subscriptions;
CREATE TRIGGER trg_subscription_update_calendar
  AFTER UPDATE OF status, current_period_end, trial_end, cancel_at_period_end, stripe_subscription_id, plan_key ON public.user_subscriptions
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        OR OLD.current_period_end IS DISTINCT FROM NEW.current_period_end
        OR OLD.trial_end IS DISTINCT FROM NEW.trial_end
        OR OLD.cancel_at_period_end IS DISTINCT FROM NEW.cancel_at_period_end
        OR OLD.stripe_subscription_id IS DISTINCT FROM NEW.stripe_subscription_id
        OR OLD.plan_key IS DISTINCT FROM NEW.plan_key)
  EXECUTE FUNCTION public.fn_subscription_to_calendar();

DROP TRIGGER IF EXISTS trg_subscription_delete_calendar ON public.user_subscriptions;
CREATE TRIGGER trg_subscription_delete_calendar
  AFTER DELETE ON public.user_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_subscription_to_calendar();

COMMENT ON FUNCTION public.fn_subscription_to_calendar() IS
  'VTID-04994: user_subscriptions -> calendar_events (source subscription): period end / renewal and trial end. Exception-safe, never blocks a billing write.';

-- 4. One-time backfill for subscriptions that already exist.
INSERT INTO public.calendar_events (
  user_id, title, start_time, end_time,
  event_type, source_type, source_ref_id, source_ref_type,
  status, role_context, reminder_offsets, metadata
)
SELECT s.user_id,
       CASE WHEN s.stripe_subscription_id IS NOT NULL AND NOT s.cancel_at_period_end THEN 'Premium renews' ELSE 'Premium ends' END,
       s.current_period_end, s.current_period_end + interval '15 minutes',
       'personal', 'subscription', s.id::text, 'subscription_period_end',
       'confirmed', 'personal', '{}'::int[],
       jsonb_build_object('kind', CASE WHEN s.stripe_subscription_id IS NOT NULL AND NOT s.cancel_at_period_end THEN 'renews' ELSE 'ends' END,
                          'plan_key', s.plan_key, 'subscription_id', s.id::text)
  FROM public.user_subscriptions s
 WHERE s.status IN ('active', 'trialing', 'past_due')
   AND s.current_period_end IS NOT NULL AND s.current_period_end > now()
   AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts b WHERE b.user_id = s.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors t WHERE t.user_id = s.user_id)
ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL DO NOTHING;

INSERT INTO public.calendar_events (
  user_id, title, start_time, end_time,
  event_type, source_type, source_ref_id, source_ref_type,
  status, role_context, reminder_offsets, metadata
)
SELECT s.user_id, 'Trial ends', s.trial_end, s.trial_end + interval '15 minutes',
       'personal', 'subscription', s.id::text, 'subscription_trial_end',
       'confirmed', 'personal', '{}'::int[],
       jsonb_build_object('kind', 'trial_ends', 'plan_key', s.plan_key, 'subscription_id', s.id::text)
  FROM public.user_subscriptions s
 WHERE s.status = 'trialing' AND s.trial_end IS NOT NULL AND s.trial_end > now()
   AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts b WHERE b.user_id = s.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors t WHERE t.user_id = s.user_id)
ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL DO NOTHING;

REVOKE ALL ON FUNCTION public.fn_subscription_to_calendar() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_subscription_calendar_sync(uuid, text, text, boolean, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated;
