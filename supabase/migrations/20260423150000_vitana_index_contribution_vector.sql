-- =============================================================================
-- autopilot_recommendations.contribution_vector — auto-populate from source_ref
-- Date: 2026-04-23
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (step 4)
--
-- Populates the contribution_vector JSONB on every autopilot_recommendations
-- insert using a single canonical map from source_ref (the signal_type) to
-- 5-pillar delta. Mirrors the tag-map in health_compute_vitana_index() v3 so
-- Autopilot activations and Calendar completions agree on what moves the
-- Index.
--
-- Also backfills existing rows where contribution_vector IS NULL.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS, UPDATE.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Helper: source_ref → JSONB contribution_vector
-- Returns {nutrition: n, hydration: n, exercise: n, sleep: n, mental: n}
-- where n ≥ 0. Unknown source_refs return {} (NULL-equivalent).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vitana_contribution_vector_from_source_ref(p_source_ref TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_nutrition INTEGER := 0;
  v_hydration INTEGER := 0;
  v_exercise  INTEGER := 0;
  v_sleep     INTEGER := 0;
  v_mental    INTEGER := 0;
BEGIN
  -- Mapping is derived from the wellness_tags on each COMMUNITY_ACTIONS entry
  -- in autopilot-recommendations.ts. Kept in sync by convention.
  CASE COALESCE(p_source_ref, '')
    -- Weakness-driven
    WHEN 'weakness_movement' THEN v_exercise := 6;
    WHEN 'weakness_nutrition' THEN v_nutrition := 6;
    WHEN 'weakness_sleep' THEN v_sleep := 6;
    WHEN 'weakness_stress' THEN v_mental := 6;
    WHEN 'weakness_social' THEN v_mental := 4; -- social → mental (community well-being)

    -- Engagement
    WHEN 'engage_health' THEN v_exercise := 2; -- health-check halo: small bumps everywhere below
    WHEN 'engage_meetup' THEN v_mental := 4;
    WHEN 'deepen_connection' THEN v_mental := 4;
    WHEN 'set_goal' THEN v_mental := 4;
    WHEN 'start_streak' THEN v_exercise := 4;

    -- Mood-driven
    WHEN 'mood_support' THEN v_mental := 6;
    WHEN 'mood_energy' THEN v_exercise := 4;

    -- Onboarding (small halo — +1 to all)
    WHEN 'onboarding_profile' THEN
      v_nutrition := 1; v_hydration := 1; v_exercise := 1; v_sleep := 1; v_mental := 1;
    WHEN 'onboarding_avatar' THEN
      v_nutrition := 1; v_hydration := 1; v_exercise := 1; v_sleep := 1; v_mental := 1;
    WHEN 'onboarding_explore' THEN v_mental := 2;
    WHEN 'onboarding_interests' THEN v_mental := 1;
    WHEN 'onboarding_maxina' THEN v_mental := 2;
    WHEN 'onboarding_diary', 'onboarding_diary_day0' THEN v_mental := 4;
    WHEN 'onboarding_health' THEN v_exercise := 2;
    WHEN 'onboarding_matches', 'onboarding_discover_matches', 'engage_matches' THEN v_mental := 2;
    WHEN 'onboarding_group' THEN v_mental := 2;

    -- Advanced
    WHEN 'share_expertise' THEN v_mental := 2;
    WHEN 'invite_friend' THEN v_mental := 2;

    -- Streaks (small universal boost)
    WHEN 'streak_celebration', 'streak_continue' THEN
      v_nutrition := 1; v_hydration := 1; v_exercise := 1; v_sleep := 1; v_mental := 1;

    ELSE
      -- Unknown source_ref — return empty object so callers can distinguish
      -- "no contribution mapped" from "explicit zero".
      RETURN '{}'::JSONB;
  END CASE;

  RETURN jsonb_build_object(
    'nutrition', v_nutrition,
    'hydration', v_hydration,
    'exercise',  v_exercise,
    'sleep',     v_sleep,
    'mental',    v_mental
  );
END;
$$;

COMMENT ON FUNCTION public.vitana_contribution_vector_from_source_ref(TEXT) IS
  'Maps an autopilot source_ref (signal_type) to a 5-pillar JSONB contribution vector. Keyed to the COMMUNITY_ACTIONS wellness_tags in autopilot-recommendations.ts and the tag map in health_compute_vitana_index() v3.';

-- -----------------------------------------------------------------------------
-- Trigger: on INSERT of autopilot_recommendations, populate contribution_vector
-- from source_ref if the caller didn't provide one.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vitana_autopilot_contribution_vector_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.contribution_vector IS NULL OR NEW.contribution_vector = '{}'::JSONB THEN
    NEW.contribution_vector := public.vitana_contribution_vector_from_source_ref(NEW.source_ref);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_autopilot_recommendations_contribution_vector
  ON public.autopilot_recommendations;

CREATE TRIGGER trg_autopilot_recommendations_contribution_vector
  BEFORE INSERT ON public.autopilot_recommendations
  FOR EACH ROW
  EXECUTE FUNCTION public.vitana_autopilot_contribution_vector_trigger();

-- -----------------------------------------------------------------------------
-- Backfill existing rows.
-- -----------------------------------------------------------------------------
UPDATE public.autopilot_recommendations
SET contribution_vector = public.vitana_contribution_vector_from_source_ref(source_ref)
WHERE contribution_vector IS NULL
   OR contribution_vector = '{}'::JSONB;

-- =============================================================================
-- calendar_events.completion_status → trigger recompute
-- When a row transitions to completion_status='completed', automatically
-- invoke health_compute_vitana_index_for_user() for today. This guarantees
-- the Index tracks completion regardless of which code path wrote the
-- update (gateway /events/:id/complete, direct Supabase from the UI,
-- background job, etc.).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.vitana_trg_calendar_completion_recompute()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only react to transitions INTO 'completed' (new row or status change).
  IF NEW.completion_status = 'completed'
     AND (OLD.completion_status IS DISTINCT FROM 'completed')
     AND NEW.user_id IS NOT NULL
  THEN
    BEGIN
      PERFORM public.health_compute_vitana_index_for_user(
        NEW.user_id,
        CURRENT_DATE,
        'v3-5pillar'
      );
    EXCEPTION WHEN OTHERS THEN
      -- Never block a calendar update on a recompute failure.
      RAISE WARNING 'vitana recompute on completion failed: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_calendar_completion_recompute
  ON public.calendar_events;

CREATE TRIGGER trg_calendar_completion_recompute
  AFTER UPDATE OF completion_status ON public.calendar_events
  FOR EACH ROW
  EXECUTE FUNCTION public.vitana_trg_calendar_completion_recompute();

COMMENT ON FUNCTION public.vitana_trg_calendar_completion_recompute() IS
  'AFTER UPDATE trigger on calendar_events.completion_status. When a row transitions to completed, invokes health_compute_vitana_index_for_user for today so the Vitana Index reflects the new completion regardless of which client wrote the update.';

NOTIFY pgrst, 'reload schema';

COMMIT;
