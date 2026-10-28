-- VTID-04489 — get_index_boost(p_user_id): what drove a member's Vitana
-- Index, in activity terms ("running — 4× this week"), for the profile's
-- Vitana Index card and "About your VITANA INDEX" drawer.
--
-- Read-only. Built for bragging and friendly competition when a profile is
-- shared, so by the platform owner's decision (2026-09-24) it is visible to
-- every signed-in member WITH numbers. A member can hide it with
-- account_visibility.indexBoost = 'private' (or 'connections'); the default
-- is public.
--
-- Sources, subject's own rows only:
--   health_features_daily   workouts (free-text activity_type normalised to
--                           a fixed set), meals, water, sleep, meditation
--   journey_session_index_awards  guided journey sessions
--   vitana_index_scores     Index change over the same window, to decide
--                           between "Biggest boost" (Index rose) and
--                           "Most active" (it did not), and to rank drivers
--                           whose pillar actually rose first
-- Window: the last 7 days when the member logged at least 2 things in them,
-- otherwise the last 30. The window is returned so the UI says which.
-- No weight data exists anywhere yet, so weight loss cannot be a driver.

CREATE OR REPLACE FUNCTION public._index_boost_activity_key(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p IS NULL OR btrim(p) = '' THEN 'workout'
    WHEN lower(p) ~ '(lauf|jogg|run|trč|trc|correr|course|бег)' THEN 'running'
    WHEN lower(p) ~ '(fahrrad|radfahr|bike|cycl|bicic|vélo|velo|bicikl|вело)' THEN 'cycling'
    WHEN lower(p) ~ '(kraft|strength|gym|weight|hantel|fuerza|musculation|teretan|силов)' THEN 'strength'
    WHEN lower(p) ~ '(padel|paddle|tennis|tenis)' THEN 'racket'
    WHEN lower(p) ~ '(yoga|pilates|stretch|dehn|estiram|étirement|istezanj)' THEN 'yoga_pilates'
    WHEN lower(p) ~ '(schwimm|swim|natac|nage|plivan|плав)' THEN 'swimming'
    WHEN lower(p) ~ '(walk|spazier|gehen|wander|hike|schritt|step|camina|paseo|marche|šetn|setn|ходьб)' THEN 'walking'
    ELSE 'workout'
  END
$fn$;

CREATE OR REPLACE FUNCTION public.get_index_boost(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_viewer   uuid := auth.uid();
  v_is_owner boolean;
  v_vis      text;
  v_window   integer;
  v_recent   integer;
  v_latest   public.vitana_index_scores%ROWTYPE;
  v_prev     public.vitana_index_scores%ROWTYPE;
  v_has_prev boolean := false;
  v_delta    integer := NULL;
  v_drivers  jsonb;
BEGIN
  IF p_user_id IS NULL OR v_viewer IS NULL THEN
    RETURN NULL;
  END IF;

  v_is_owner := v_viewer = p_user_id;
  IF NOT v_is_owner THEN
    SELECT coalesce(p.account_visibility->>'indexBoost', 'public')
      INTO v_vis FROM public.profiles p WHERE p.user_id = p_user_id;
    v_vis := coalesce(v_vis, 'public');
    IF v_vis = 'private'
       OR (v_vis = 'connections'
           AND public.get_viewer_relationship(v_viewer, p_user_id) <> 'connection') THEN
      RETURN jsonb_build_object('hidden', true);
    END IF;
  END IF;

  SELECT (SELECT count(*) FROM public.health_features_daily h
           WHERE h.user_id = p_user_id AND h.date > current_date - 7
             AND h.feature_key IN ('wearable_workout','meal_log','macro_balance','water_intake','wearable_sleep_duration','meditation_minutes'))
       + (SELECT count(*) FROM public.journey_session_index_awards j
           WHERE j.user_id = p_user_id AND j.created_at > now() - interval '7 days')
    INTO v_recent;
  v_window := CASE WHEN v_recent >= 2 THEN 7 ELSE 30 END;

  SELECT * INTO v_latest FROM public.vitana_index_scores s
   WHERE s.user_id = p_user_id ORDER BY s.date DESC LIMIT 1;
  IF FOUND THEN
    SELECT * INTO v_prev FROM public.vitana_index_scores s
     WHERE s.user_id = p_user_id
       AND s.date >= v_latest.date - (v_window - 1)
       AND s.date < v_latest.date
     ORDER BY s.date ASC LIMIT 1;
    v_has_prev := FOUND;
    IF v_has_prev THEN
      v_delta := v_latest.score_total - v_prev.score_total;
    END IF;
  END IF;

  WITH pillar_delta(pillar, delta) AS (
    VALUES
      ('exercise',  CASE WHEN v_has_prev THEN v_latest.score_exercise  - v_prev.score_exercise  END),
      ('nutrition', CASE WHEN v_has_prev THEN v_latest.score_nutrition - v_prev.score_nutrition END),
      ('hydration', CASE WHEN v_has_prev THEN v_latest.score_hydration - v_prev.score_hydration END),
      ('sleep',     CASE WHEN v_has_prev THEN v_latest.score_sleep     - v_prev.score_sleep     END),
      ('mental',    CASE WHEN v_has_prev THEN v_latest.score_mental    - v_prev.score_mental    END)
  ),
  h AS (
    SELECT * FROM public.health_features_daily
     WHERE user_id = p_user_id AND date > current_date - v_window
  ),
  candidates AS (
    SELECT 'workout'::text AS type, public._index_boost_activity_key(h.metadata->>'activity_type') AS activity,
           'exercise'::text AS pillar, count(*)::integer AS n, sum(h.feature_value) AS total
      FROM h WHERE h.feature_key = 'wearable_workout'
     GROUP BY 2
    UNION ALL
    SELECT 'nutrition', NULL, 'nutrition', count(DISTINCT h.date)::integer, NULL
      FROM h WHERE h.feature_key IN ('meal_log', 'macro_balance') HAVING count(*) > 0
    UNION ALL
    SELECT 'hydration', NULL, 'hydration', count(DISTINCT h.date)::integer, avg(h.feature_value)
      FROM h WHERE h.feature_key = 'water_intake' HAVING count(*) > 0
    UNION ALL
    SELECT 'sleep', NULL, 'sleep', count(DISTINCT h.date)::integer, avg(h.feature_value)
      FROM h WHERE h.feature_key = 'wearable_sleep_duration' HAVING count(*) > 0
    UNION ALL
    SELECT 'mindfulness', NULL, 'mental', count(*)::integer, sum(h.feature_value)
      FROM h WHERE h.feature_key = 'meditation_minutes' HAVING count(*) > 0
    UNION ALL
    SELECT 'journey', NULL, 'mental', count(*)::integer, sum(j.points)
      FROM public.journey_session_index_awards j
     WHERE j.user_id = p_user_id AND j.created_at > now() - make_interval(days => v_window)
    HAVING count(*) > 0
  ),
  ranked AS (
    SELECT c.*, d.delta,
           -- Pillars that rose come first (largest rise first); after that,
           -- whatever the member did most. A pillar that fell never outranks
           -- more activity just because it fell less.
           row_number() OVER (ORDER BY (coalesce(d.delta, 0) > 0) DESC,
                                       CASE WHEN d.delta > 0 THEN d.delta END DESC NULLS LAST,
                                       c.n DESC, c.type) AS rn
      FROM candidates c LEFT JOIN pillar_delta d ON d.pillar = c.pillar
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'type', type, 'activity', activity, 'pillar', pillar,
           'count', n, 'total', round(total), 'pillar_delta', delta) ORDER BY rn), '[]'::jsonb)
    INTO v_drivers
    FROM ranked WHERE rn <= 3;

  RETURN jsonb_build_object(
    'hidden',      false,
    'is_owner',    v_is_owner,
    'window_days', v_window,
    'kind',        CASE WHEN v_delta IS NOT NULL AND v_delta > 0 THEN 'boost' ELSE 'active' END,
    'index_delta', v_delta,
    'drivers',     v_drivers
  );
END;
$fn$;

COMMENT ON FUNCTION public.get_index_boost(uuid) IS
  'VTID-04489: top activity drivers (last 7 or 30 days) behind a member''s Vitana Index for the profile card and drawer. Public with numbers by owner decision; hidden when account_visibility.indexBoost is private (or connections for non-connections).';

REVOKE ALL ON FUNCTION public.get_index_boost(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_index_boost(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_index_boost(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public._index_boost_activity_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._index_boost_activity_key(text) FROM anon;
GRANT EXECUTE ON FUNCTION public._index_boost_activity_key(text) TO authenticated;
