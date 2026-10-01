-- VTID-04483 — get_profile_health_summary(p_user_id): the real data behind the
-- profile Health tab and the Health page's community standing.
--
-- Read-only. Writes nothing, creates no table. The frontend keeps rendering
-- its existing mock screens until VITE_HEALTH_REAL_DATA is switched on; this
-- function is the data those real screens read when it is.
--
-- Why an RPC and not direct table reads:
--   * vitana_index_scores RLS is own-rows only, so a member can never rank
--     themselves against anyone from the browser.
--   * health_features_daily's SELECT policy gates on current_tenant_id(),
--     which reads a JWT claim Supabase never issues (the VTID-04044 root
--     cause), so browser reads of it return nothing.
--   A SECURITY DEFINER function scoped explicitly to auth.uid() and to the
--   subject's own consent is narrower than widening either policy.
--
-- What each viewer gets:
--   everyone signed in  score, tier inputs, community standing (the score is
--                       already public via get_public_vitana_index; standing
--                       is an aggregate over it)
--   shared viewers      + pillars with 7-day change, achievements
--                       (owner always; others only if the subject set
--                       account_visibility.vitanaHealth to 'public', or to
--                       'connections' and the viewer is a connection —
--                       default is 'private')
--   owner only          + activity from health_features_daily (sleep, water,
--                       workouts, steps, meditation, logging streak)
--
-- Honesty rules the frontend relies on:
--   * No community comparison below c_min_cohort members — standing comes
--     back available=false with the current cohort size, so readiness is
--     measurable and the UI turns on by itself as membership grows.
--   * The cohort is the subject's tenant, latest score per member in the last
--     30 days, excluding service_bot_accounts and notification_test_actors
--     (platform rule 45: test/service accounts never shape what members see).
--   * "Personal best" needs c_min_history scored days and a real rise.

CREATE OR REPLACE FUNCTION public.get_profile_health_summary(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  c_min_cohort   CONSTANT integer := 20;  -- members before any comparison is shown
  c_min_history  CONSTANT integer := 7;   -- scored days before "personal best"
  c_rising_delta CONSTANT integer := 20;  -- matches the index drawer's "huge week"
  v_viewer       uuid := auth.uid();
  v_is_owner     boolean;
  v_shared       boolean := false;
  v_tier         text;
  v_latest       public.vitana_index_scores%ROWTYPE;
  v_week         public.vitana_index_scores%ROWTYPE;
  v_has_week     boolean := false;
  v_cohort       integer := 0;
  v_higher       integer := 0;
  v_avg          numeric;
  v_standing     jsonb;
  v_pillars      jsonb := NULL;
  v_achievements jsonb := '[]'::jsonb;
  v_activity     jsonb := NULL;
  v_best         integer;
  v_min          integer;
  v_days         integer;
  v_week_delta   integer := NULL;
  v_streak       integer := 0;
  v_day          date;
BEGIN
  IF p_user_id IS NULL OR v_viewer IS NULL THEN
    RETURN NULL;
  END IF;

  v_is_owner := v_viewer = p_user_id;

  IF v_is_owner THEN
    v_shared := true;
  ELSE
    SELECT coalesce(p.account_visibility->>'vitanaHealth', 'private')
      INTO v_tier
      FROM public.profiles p
     WHERE p.user_id = p_user_id;
    v_tier := coalesce(v_tier, 'private');
    IF v_tier = 'public' THEN
      v_shared := true;
    ELSIF v_tier = 'connections' THEN
      v_shared := public.get_viewer_relationship(v_viewer, p_user_id) = 'connection';
    END IF;
  END IF;

  SELECT * INTO v_latest
    FROM public.vitana_index_scores s
   WHERE s.user_id = p_user_id
   ORDER BY s.date DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'has_index', false,
      'is_owner', v_is_owner,
      'shared', v_shared,
      'thresholds', jsonb_build_object('min_cohort', c_min_cohort)
    );
  END IF;

  -- ── Community standing ─────────────────────────────────────────────────
  WITH latest AS (
    SELECT DISTINCT ON (s.user_id) s.user_id, s.score_total
      FROM public.vitana_index_scores s
     WHERE s.tenant_id = v_latest.tenant_id
       AND s.date > current_date - 30
     ORDER BY s.user_id, s.date DESC
  )
  SELECT count(*),
         count(*) FILTER (WHERE l.score_total > v_latest.score_total),
         avg(l.score_total)
    INTO v_cohort, v_higher, v_avg
    FROM latest l
   WHERE l.user_id <> p_user_id
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts b WHERE b.user_id = l.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors a WHERE a.user_id = l.user_id);

  IF v_cohort + 1 >= c_min_cohort THEN
    v_standing := jsonb_build_object(
      'available', true,
      -- "Top X%": the subject's rank (1 = highest) as a share of the cohort.
      'top_percent', greatest(1, ceil(100.0 * (v_higher + 1) / (v_cohort + 1)))::integer,
      'community_average', round(v_avg)::integer,
      'cohort_size', v_cohort + 1
    );
  ELSE
    v_standing := jsonb_build_object(
      'available', false,
      'reason', 'cohort_too_small',
      'cohort_size', v_cohort + 1
    );
  END IF;

  -- ── 7-day change ───────────────────────────────────────────────────────
  SELECT * INTO v_week
    FROM public.vitana_index_scores s
   WHERE s.user_id = p_user_id
     AND s.date >= v_latest.date - 6
     AND s.date < v_latest.date
   ORDER BY s.date ASC
   LIMIT 1;
  v_has_week := FOUND;
  IF v_has_week THEN
    v_week_delta := v_latest.score_total - v_week.score_total;
  END IF;

  -- ── Pillars + achievements (shared viewers) ────────────────────────────
  IF v_shared THEN
    v_pillars := jsonb_build_object(
      'nutrition', jsonb_build_object('score', v_latest.score_nutrition,
        'delta_7d', CASE WHEN v_has_week THEN v_latest.score_nutrition - v_week.score_nutrition END),
      'hydration', jsonb_build_object('score', v_latest.score_hydration,
        'delta_7d', CASE WHEN v_has_week THEN v_latest.score_hydration - v_week.score_hydration END),
      'exercise',  jsonb_build_object('score', v_latest.score_exercise,
        'delta_7d', CASE WHEN v_has_week THEN v_latest.score_exercise - v_week.score_exercise END),
      'sleep',     jsonb_build_object('score', v_latest.score_sleep,
        'delta_7d', CASE WHEN v_has_week THEN v_latest.score_sleep - v_week.score_sleep END),
      'mental',    jsonb_build_object('score', v_latest.score_mental,
        'delta_7d', CASE WHEN v_has_week THEN v_latest.score_mental - v_week.score_mental END)
    );

    SELECT max(s.score_total), min(s.score_total), count(*)
      INTO v_best, v_min, v_days
      FROM public.vitana_index_scores s
     WHERE s.user_id = p_user_id;

    IF v_days >= c_min_history AND v_latest.score_total >= v_best AND v_min < v_best THEN
      v_achievements := v_achievements || jsonb_build_array(
        jsonb_build_object('type', 'personal_best', 'score', v_latest.score_total));
    END IF;
    IF v_week_delta IS NOT NULL AND v_week_delta >= c_rising_delta THEN
      v_achievements := v_achievements || jsonb_build_array(
        jsonb_build_object('type', 'rising_week', 'delta', v_week_delta));
    END IF;
  END IF;

  -- ── Activity (owner only) ──────────────────────────────────────────────
  IF v_is_owner THEN
    SELECT jsonb_build_object(
             'days_logged_7d',        count(DISTINCT h.date),
             'sleep_avg_minutes_7d',  round(avg(h.feature_value) FILTER (WHERE h.feature_key = 'wearable_sleep_duration')),
             'sleep_nights_7d',       count(DISTINCT h.date) FILTER (WHERE h.feature_key = 'wearable_sleep_duration'),
             'water_avg_ml_7d',       round(avg(h.feature_value) FILTER (WHERE h.feature_key = 'water_intake')),
             'workout_minutes_7d',    round(sum(h.feature_value) FILTER (WHERE h.feature_key = 'wearable_workout')),
             'steps_avg_7d',          round(avg(h.feature_value) FILTER (WHERE h.feature_key = 'wearable_steps')),
             'meditation_minutes_7d', round(sum(h.feature_value) FILTER (WHERE h.feature_key = 'meditation_minutes'))
           )
      INTO v_activity
      FROM public.health_features_daily h
     WHERE h.user_id = p_user_id
       AND h.date > current_date - 7;

    -- Logging streak: consecutive days with any entry, ending today (or
    -- yesterday, so a streak doesn't read as broken before today's log).
    v_day := current_date;
    IF NOT EXISTS (SELECT 1 FROM public.health_features_daily h
                    WHERE h.user_id = p_user_id AND h.date = v_day) THEN
      v_day := v_day - 1;
    END IF;
    WHILE v_streak < 366 AND EXISTS (SELECT 1 FROM public.health_features_daily h
                                      WHERE h.user_id = p_user_id AND h.date = v_day) LOOP
      v_streak := v_streak + 1;
      v_day := v_day - 1;
    END LOOP;
    v_activity := v_activity || jsonb_build_object('logging_streak_days', v_streak);

    IF v_streak >= 3 THEN
      v_achievements := v_achievements || jsonb_build_array(
        jsonb_build_object('type', 'logging_streak', 'days', v_streak));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'has_index',    true,
    'is_owner',     v_is_owner,
    'shared',       v_shared,
    'score',        v_latest.score_total,
    'score_date',   v_latest.date,
    'is_baseline',  coalesce(v_latest.model_version LIKE 'baseline%', false),
    'week_delta',   v_week_delta,
    'standing',     v_standing,
    'pillars',      v_pillars,
    'achievements', v_achievements,
    'activity',     v_activity,
    'thresholds',   jsonb_build_object('min_cohort', c_min_cohort, 'min_history_days', c_min_history)
  );
END;
$fn$;

COMMENT ON FUNCTION public.get_profile_health_summary(uuid) IS
  'VTID-04483: read-only health summary for a profile. Standing for any signed-in viewer (only with >= 20 active members in the tenant, excluding service/test accounts); pillars + achievements when the subject shares (account_visibility.vitanaHealth, default private); activity for the owner only.';

REVOKE ALL ON FUNCTION public.get_profile_health_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_profile_health_summary(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_profile_health_summary(uuid) TO authenticated;
