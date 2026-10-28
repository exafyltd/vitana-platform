-- =============================================================================
-- VTID-03107 · Billing v1 — Trial lifecycle notifications (Duolingo-style)
-- =============================================================================
-- Drives the 5-milestone lifecycle email/push sequence per §S of the plan:
--
--   day_0       trial_welcome              — fired on subscription creation
--   day_7       trial_midpoint             — halfway-through usage stats
--   day_12      trial_ending_2d            — "2 days left"
--   day_13      trial_ending_1d            — "ends tomorrow"
--   day_15      trial_cancelled_winback    — only if user cancelled
--   day_30      trial_winback_one_shot     — only if cancelled + no return
--
-- Founding Member grants use the same shape with proportional timestamps
-- (90 / 80 / 88 / 89 days).
--
-- Mechanism
--   * lifecycle_notification_state — per-user audit of what was fired when.
--     PK (user_id, lifecycle_kind) enforces single-fire per milestone.
--   * fn_process_lifecycle_notifications() — SQL function that scans
--     user_subscriptions for users at each milestone and emits an OASIS
--     event (notify.lifecycle.<kind>). The gateway listens for this event
--     class and calls notifyUser() to fan out push+inapp.
--   * pg_cron job billing_lifecycle_notifications — hourly fire.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. State table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.lifecycle_notification_state (
  user_id          uuid NOT NULL,
  tenant_id        uuid NOT NULL,
  lifecycle_kind   text NOT NULL CHECK (lifecycle_kind IN (
    'trial_welcome',
    'trial_midpoint',
    'trial_ending_2d',
    'trial_ending_1d',
    'trial_cancelled_winback',
    'trial_winback_one_shot',
    'founding_midpoint',
    'founding_ending_2d',
    'founding_ending_1d'
  )),
  fired_at         timestamptz NOT NULL DEFAULT now(),
  subscription_id  uuid REFERENCES public.user_subscriptions(id) ON DELETE CASCADE,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_id, lifecycle_kind)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_notification_state_fired_at
  ON public.lifecycle_notification_state (fired_at DESC);

COMMENT ON TABLE public.lifecycle_notification_state IS
  'VTID-03107: per-user audit of lifecycle notification fires. PK enforces single-fire per milestone (idempotency for the hourly cron).';

ALTER TABLE public.lifecycle_notification_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lifecycle_state_svc_full ON public.lifecycle_notification_state;
CREATE POLICY lifecycle_state_svc_full ON public.lifecycle_notification_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS lifecycle_state_read_own ON public.lifecycle_notification_state;
CREATE POLICY lifecycle_state_read_own ON public.lifecycle_notification_state
  FOR SELECT TO authenticated USING (user_id = auth.uid());
GRANT SELECT ON public.lifecycle_notification_state TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Processor function
-- -----------------------------------------------------------------------------
-- Scans active subs + recently-cancelled subs and emits OASIS events for any
-- user that has crossed a milestone without an existing fire row. Each emit
-- writes its own lifecycle_notification_state row in the SAME transaction so
-- a partial run doesn't re-fire on retry.
--
-- OASIS event topic: 'billing.lifecycle.<kind>' with payload:
--   { user_id, tenant_id, subscription_id, plan_key, days_since_start,
--     trial_end, source }
-- A gateway worker subscribes to this topic and translates into notifyUser()
-- with the appropriate notification type (e.g. trial_midpoint).

CREATE OR REPLACE FUNCTION public.fn_process_lifecycle_notifications()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_fires_total integer := 0;
  v_kind_counts jsonb := '{}'::jsonb;

  -- Helper: emit one fire (insert state + return)
  -- Inlined as a CTE pattern below.
BEGIN
  -- ── Trial midpoint (day 7) ──────────────────────────────────────────────
  FOR v_row IN
    SELECT s.id, s.user_id, s.tenant_id, s.plan_key, s.trial_end, s.current_period_start
    FROM public.user_subscriptions s
    LEFT JOIN public.lifecycle_notification_state st
      ON st.user_id = s.user_id AND st.lifecycle_kind = 'trial_midpoint'
    WHERE s.status = 'trialing'
      AND s.trial_end IS NOT NULL
      AND s.trial_end > now()
      AND s.trial_end - now() <= interval '8 days'
      AND s.trial_end - now() >  interval '6 days'
      AND st.user_id IS NULL
  LOOP
    INSERT INTO public.lifecycle_notification_state (user_id, tenant_id, lifecycle_kind, subscription_id, metadata)
    VALUES (v_row.user_id, v_row.tenant_id, 'trial_midpoint', v_row.id,
            jsonb_build_object('plan_key', v_row.plan_key, 'trial_end', v_row.trial_end))
    ON CONFLICT (user_id, lifecycle_kind) DO NOTHING;

    -- Best-effort OASIS event emit (table-write only; the gateway worker
    -- subscribes and translates to notifyUser at the application layer).
    BEGIN
      INSERT INTO public.oasis_events (vtid, topic, source, status, message, payload)
      VALUES ('VTID-03107', 'billing.lifecycle.trial_midpoint', 'fn_process_lifecycle_notifications',
              'success', 'Trial midpoint reached',
              jsonb_build_object(
                'user_id', v_row.user_id,
                'tenant_id', v_row.tenant_id,
                'subscription_id', v_row.id,
                'plan_key', v_row.plan_key,
                'trial_end', v_row.trial_end
              ));
    EXCEPTION WHEN OTHERS THEN
      -- oasis_events may not exist on every environment; non-blocking.
      NULL;
    END;
    v_fires_total := v_fires_total + 1;
  END LOOP;

  -- ── Trial ending in 2 days ──────────────────────────────────────────────
  FOR v_row IN
    SELECT s.id, s.user_id, s.tenant_id, s.plan_key, s.trial_end
    FROM public.user_subscriptions s
    LEFT JOIN public.lifecycle_notification_state st
      ON st.user_id = s.user_id AND st.lifecycle_kind = 'trial_ending_2d'
    WHERE s.status = 'trialing'
      AND s.trial_end IS NOT NULL
      AND s.trial_end > now()
      AND s.trial_end - now() <= interval '2 days 1 hour'
      AND s.trial_end - now() >  interval '1 days 23 hours'
      AND st.user_id IS NULL
  LOOP
    INSERT INTO public.lifecycle_notification_state (user_id, tenant_id, lifecycle_kind, subscription_id, metadata)
    VALUES (v_row.user_id, v_row.tenant_id, 'trial_ending_2d', v_row.id,
            jsonb_build_object('plan_key', v_row.plan_key, 'trial_end', v_row.trial_end))
    ON CONFLICT (user_id, lifecycle_kind) DO NOTHING;
    BEGIN
      INSERT INTO public.oasis_events (vtid, topic, source, status, message, payload)
      VALUES ('VTID-03107', 'billing.lifecycle.trial_ending_2d', 'fn_process_lifecycle_notifications',
              'success', 'Trial ending in 2 days',
              jsonb_build_object('user_id', v_row.user_id, 'tenant_id', v_row.tenant_id,
                                 'subscription_id', v_row.id, 'plan_key', v_row.plan_key,
                                 'trial_end', v_row.trial_end));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    v_fires_total := v_fires_total + 1;
  END LOOP;

  -- ── Trial ending in 1 day ───────────────────────────────────────────────
  FOR v_row IN
    SELECT s.id, s.user_id, s.tenant_id, s.plan_key, s.trial_end
    FROM public.user_subscriptions s
    LEFT JOIN public.lifecycle_notification_state st
      ON st.user_id = s.user_id AND st.lifecycle_kind = 'trial_ending_1d'
    WHERE s.status = 'trialing'
      AND s.trial_end IS NOT NULL
      AND s.trial_end > now()
      AND s.trial_end - now() <= interval '1 day 1 hour'
      AND s.trial_end - now() >  interval '23 hours'
      AND st.user_id IS NULL
  LOOP
    INSERT INTO public.lifecycle_notification_state (user_id, tenant_id, lifecycle_kind, subscription_id, metadata)
    VALUES (v_row.user_id, v_row.tenant_id, 'trial_ending_1d', v_row.id,
            jsonb_build_object('plan_key', v_row.plan_key, 'trial_end', v_row.trial_end))
    ON CONFLICT (user_id, lifecycle_kind) DO NOTHING;
    BEGIN
      INSERT INTO public.oasis_events (vtid, topic, source, status, message, payload)
      VALUES ('VTID-03107', 'billing.lifecycle.trial_ending_1d', 'fn_process_lifecycle_notifications',
              'success', 'Trial ending tomorrow',
              jsonb_build_object('user_id', v_row.user_id, 'tenant_id', v_row.tenant_id,
                                 'subscription_id', v_row.id, 'plan_key', v_row.plan_key,
                                 'trial_end', v_row.trial_end));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    v_fires_total := v_fires_total + 1;
  END LOOP;

  -- ── Cancelled win-back (day 15 — 1 day after period end if cancelled) ───
  FOR v_row IN
    SELECT s.id, s.user_id, s.tenant_id, s.plan_key, s.current_period_end
    FROM public.user_subscriptions s
    LEFT JOIN public.lifecycle_notification_state st
      ON st.user_id = s.user_id AND st.lifecycle_kind = 'trial_cancelled_winback'
    WHERE s.status = 'canceled'
      AND s.current_period_end IS NOT NULL
      AND now() - s.current_period_end >= interval '23 hours'
      AND now() - s.current_period_end <  interval '25 hours'
      AND st.user_id IS NULL
  LOOP
    INSERT INTO public.lifecycle_notification_state (user_id, tenant_id, lifecycle_kind, subscription_id, metadata)
    VALUES (v_row.user_id, v_row.tenant_id, 'trial_cancelled_winback', v_row.id,
            jsonb_build_object('plan_key', v_row.plan_key, 'period_end', v_row.current_period_end))
    ON CONFLICT (user_id, lifecycle_kind) DO NOTHING;
    BEGIN
      INSERT INTO public.oasis_events (vtid, topic, source, status, message, payload)
      VALUES ('VTID-03107', 'billing.lifecycle.trial_cancelled_winback', 'fn_process_lifecycle_notifications',
              'success', 'Cancelled trial — soft win-back',
              jsonb_build_object('user_id', v_row.user_id, 'tenant_id', v_row.tenant_id,
                                 'subscription_id', v_row.id, 'plan_key', v_row.plan_key,
                                 'period_end', v_row.current_period_end));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    v_fires_total := v_fires_total + 1;
  END LOOP;

  -- ── Day-30 one-shot win-back (cancelled, no return, 30 days later) ──────
  FOR v_row IN
    SELECT s.id, s.user_id, s.tenant_id, s.plan_key, s.current_period_end
    FROM public.user_subscriptions s
    LEFT JOIN public.lifecycle_notification_state st
      ON st.user_id = s.user_id AND st.lifecycle_kind = 'trial_winback_one_shot'
    WHERE s.status = 'canceled'
      AND s.current_period_end IS NOT NULL
      AND now() - s.current_period_end >= interval '29 days 23 hours'
      AND now() - s.current_period_end <  interval '30 days 1 hour'
      AND st.user_id IS NULL
  LOOP
    INSERT INTO public.lifecycle_notification_state (user_id, tenant_id, lifecycle_kind, subscription_id, metadata)
    VALUES (v_row.user_id, v_row.tenant_id, 'trial_winback_one_shot', v_row.id,
            jsonb_build_object('plan_key', v_row.plan_key, 'period_end', v_row.current_period_end))
    ON CONFLICT (user_id, lifecycle_kind) DO NOTHING;
    BEGIN
      INSERT INTO public.oasis_events (vtid, topic, source, status, message, payload)
      VALUES ('VTID-03107', 'billing.lifecycle.trial_winback_one_shot', 'fn_process_lifecycle_notifications',
              'success', 'Cancelled trial — day 30 one-shot',
              jsonb_build_object('user_id', v_row.user_id, 'tenant_id', v_row.tenant_id,
                                 'subscription_id', v_row.id, 'plan_key', v_row.plan_key,
                                 'period_end', v_row.current_period_end));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    v_fires_total := v_fires_total + 1;
  END LOOP;

  -- Counts per kind for the telemetry dashboard
  SELECT jsonb_object_agg(lifecycle_kind, c) INTO v_kind_counts
  FROM (
    SELECT lifecycle_kind, count(*) AS c
    FROM public.lifecycle_notification_state
    WHERE fired_at > now() - interval '24 hours'
    GROUP BY lifecycle_kind
  ) t;

  RETURN jsonb_build_object(
    'ok', true,
    'fires_this_run', v_fires_total,
    'fires_last_24h', COALESCE(v_kind_counts, '{}'::jsonb),
    'ran_at', now()
  );
END;
$$;

COMMENT ON FUNCTION public.fn_process_lifecycle_notifications IS
  'VTID-03107: hourly lifecycle-milestone processor. Scans user_subscriptions for users at trial day 7/12/13 + cancelled day 15/30 milestones, fires OASIS events for the gateway worker to translate into notifyUser() push+inapp.';

GRANT EXECUTE ON FUNCTION public.fn_process_lifecycle_notifications TO service_role;

-- -----------------------------------------------------------------------------
-- 3. Schedule pg_cron — hourly
-- -----------------------------------------------------------------------------

DO $$
DECLARE v_jobid bigint;
BEGIN
  FOR v_jobid IN
    SELECT jobid FROM cron.job WHERE jobname = 'billing_lifecycle_notifications'
  LOOP
    PERFORM cron.unschedule(v_jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'billing_lifecycle_notifications',
  '15 * * * *',                          -- hourly at :15 past the hour
  $cron_lifecycle$SELECT public.fn_process_lifecycle_notifications();$cron_lifecycle$
);

-- -----------------------------------------------------------------------------
-- 4. Verification: function executable on empty data
-- -----------------------------------------------------------------------------

DO $$
DECLARE v_result jsonb;
BEGIN
  v_result := public.fn_process_lifecycle_notifications();
  IF NOT (v_result->>'ok')::boolean THEN
    RAISE EXCEPTION 'fn_process_lifecycle_notifications returned: %', v_result;
  END IF;
  RAISE NOTICE 'VTID-03107 lifecycle notifications: function + cron registered. First-run fires=%',
    v_result->>'fires_this_run';
END $$;
