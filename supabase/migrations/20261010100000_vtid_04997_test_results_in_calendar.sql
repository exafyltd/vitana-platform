-- VTID-04997 — the expected date of a health test result shows in the member's calendar.
--
-- partner_health_test_orders is the single source: one calendar entry per order.
--   * entry (source_ref_type 'test_result_expected', source_ref_id = the order id):
--     wanted while the order is ordered / sample_kit_shipped / sample_received /
--     processing AND expected_result_at is set AND in the future.
--   * moved when expected_result_at changes; cancelled when the order becomes
--     cancelled / failed / quarantined / result_ready / delivered, when the date is
--     cleared or passes, or when the order is deleted; a cancelled row is revived.
-- source_type 'test_result' (new). event_type 'health', role_context 'personal',
-- reminder_offsets = '{}' (no push or reminder is created from these entries).
-- The title is the test name and nothing else: never anything from results, a
-- status text or partner data. The entry belongs to the order's own user_id.
-- Decision: the data model has no all-day concept, so the entry is a 15-minute
-- span starting at expected_result_at.
-- The trigger function can never block an order write: any error inside it is
-- caught and logged as a WARNING.
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
    'reminder', 'subscription', 'test_result'
  ));

-- 2. One helper keeps a single calendar row in step with a wanted/unwanted state.
CREATE OR REPLACE FUNCTION public.fn_test_result_calendar_sync(
  p_user_id uuid, p_ref_id text, p_wanted boolean, p_when timestamptz, p_title text
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
       AND c.source_type = 'test_result' AND c.source_ref_type = 'test_result_expected'
       AND c.source_ref_id = p_ref_id;
    RETURN;
  END IF;

  INSERT INTO public.calendar_events (
    user_id, title, start_time, end_time,
    event_type, source_type, source_ref_id, source_ref_type,
    status, role_context, reminder_offsets, metadata
  ) VALUES (
    p_user_id, p_title, p_when, p_when + interval '15 minutes',
    'health', 'test_result', p_ref_id, 'test_result_expected',
    'confirmed', 'personal', '{}'::int[],
    jsonb_build_object('kind', 'test_result_expected', 'order_id', p_ref_id)
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

-- 3. The trigger function: decides the entry for one order row.
CREATE OR REPLACE FUNCTION public.fn_test_result_to_calendar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  o public.partner_health_test_orders%ROWTYPE;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      PERFORM public.fn_test_result_calendar_sync(OLD.user_id, OLD.id::text, false, NULL, NULL);
      RETURN OLD;
    END IF;

    o := NEW;
    IF EXISTS (SELECT 1 FROM public.service_bot_accounts WHERE user_id = o.user_id)
       OR EXISTS (SELECT 1 FROM public.notification_test_actors WHERE user_id = o.user_id) THEN
      RETURN NEW;
    END IF;

    PERFORM public.fn_test_result_calendar_sync(
      o.user_id, o.id::text,
      o.status IN ('ordered', 'sample_kit_shipped', 'sample_received', 'processing')
        AND o.expected_result_at IS NOT NULL AND o.expected_result_at > now(),
      o.expected_result_at, o.test_name);

    RETURN NEW;
  EXCEPTION WHEN OTHERS THEN
    -- Never block an order write because the calendar mirror failed.
    RAISE WARNING 'fn_test_result_to_calendar failed: % (%)', SQLERRM, SQLSTATE;
    RETURN COALESCE(NEW, OLD);
  END;
END;
$function$;

DROP TRIGGER IF EXISTS trg_test_result_insert_calendar ON public.partner_health_test_orders;
CREATE TRIGGER trg_test_result_insert_calendar
  AFTER INSERT ON public.partner_health_test_orders
  FOR EACH ROW
  WHEN (NEW.status IN ('ordered', 'sample_kit_shipped', 'sample_received', 'processing'))
  EXECUTE FUNCTION public.fn_test_result_to_calendar();

DROP TRIGGER IF EXISTS trg_test_result_update_calendar ON public.partner_health_test_orders;
CREATE TRIGGER trg_test_result_update_calendar
  AFTER UPDATE OF status, expected_result_at, test_name ON public.partner_health_test_orders
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        OR OLD.expected_result_at IS DISTINCT FROM NEW.expected_result_at
        OR OLD.test_name IS DISTINCT FROM NEW.test_name)
  EXECUTE FUNCTION public.fn_test_result_to_calendar();

DROP TRIGGER IF EXISTS trg_test_result_delete_calendar ON public.partner_health_test_orders;
CREATE TRIGGER trg_test_result_delete_calendar
  AFTER DELETE ON public.partner_health_test_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_test_result_to_calendar();

COMMENT ON FUNCTION public.fn_test_result_to_calendar() IS
  'VTID-04997: partner_health_test_orders -> calendar_events (source test_result): the expected result date, titled with the test name only. Exception-safe, never blocks an order write.';

-- 4. One-time backfill for orders that already exist.
INSERT INTO public.calendar_events (
  user_id, title, start_time, end_time,
  event_type, source_type, source_ref_id, source_ref_type,
  status, role_context, reminder_offsets, metadata
)
SELECT o.user_id, o.test_name, o.expected_result_at, o.expected_result_at + interval '15 minutes',
       'health', 'test_result', o.id::text, 'test_result_expected',
       'confirmed', 'personal', '{}'::int[],
       jsonb_build_object('kind', 'test_result_expected', 'order_id', o.id::text)
  FROM public.partner_health_test_orders o
 WHERE o.status IN ('ordered', 'sample_kit_shipped', 'sample_received', 'processing')
   AND o.expected_result_at IS NOT NULL AND o.expected_result_at > now()
   AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts b WHERE b.user_id = o.user_id)
   AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors t WHERE t.user_id = o.user_id)
ON CONFLICT (user_id, source_ref_id, source_ref_type) WHERE source_ref_id IS NOT NULL DO NOTHING;

REVOKE ALL ON FUNCTION public.fn_test_result_to_calendar() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_test_result_calendar_sync(uuid, text, boolean, timestamptz, text) FROM PUBLIC, anon, authenticated;
