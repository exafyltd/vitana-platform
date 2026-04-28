-- D6 reputation aggregation (VTID-DANCE-D6)
-- Daily cron: rebuild user_reputation rows from user_ratings ledger +
-- intent_events lifecycle. Cheap recompute (full table) — gives every
-- user a fresh avg_rating, completed_count, last_active_at.

CREATE OR REPLACE FUNCTION public.compute_user_reputation_daily()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int := 0;
BEGIN
  -- Upsert one row per (vitana_id, user_id) with aggregated stats.
  INSERT INTO public.user_reputation (
    vitana_id, user_id,
    completed_count, avg_rating, ratings_count, last_active_at,
    updated_at
  )
  SELECT
    p.vitana_id,
    p.user_id,
    COALESCE(c.completed_count, 0)::int,
    r.avg_rating,
    COALESCE(r.ratings_count, 0)::int,
    GREATEST(c.last_active, r.last_rated_at, p.updated_at) AS last_active_at,
    now()
  FROM public.profiles p
  LEFT JOIN (
    SELECT
      ie.actor_vitana_id AS vitana_id,
      count(*) FILTER (WHERE ie.event_type = 'match.fulfilled') AS completed_count,
      max(ie.created_at) AS last_active
    FROM public.intent_events ie
    WHERE ie.actor_vitana_id IS NOT NULL
    GROUP BY ie.actor_vitana_id
  ) c ON c.vitana_id = p.vitana_id
  LEFT JOIN (
    SELECT
      ratee_vitana_id AS vitana_id,
      avg(stars)::numeric(3,2) AS avg_rating,
      count(*)::int AS ratings_count,
      max(created_at) AS last_rated_at
    FROM public.user_ratings
    GROUP BY ratee_vitana_id
  ) r ON r.vitana_id = p.vitana_id
  WHERE p.vitana_id IS NOT NULL
  ON CONFLICT (vitana_id) DO UPDATE SET
    completed_count = EXCLUDED.completed_count,
    avg_rating      = EXCLUDED.avg_rating,
    ratings_count   = EXCLUDED.ratings_count,
    last_active_at  = EXCLUDED.last_active_at,
    updated_at      = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.compute_user_reputation_daily() IS
  'D6: rebuild user_reputation aggregates from user_ratings + intent_events. Idempotent. Schedule via pg_cron at 04:00 UTC.';

DO $$
BEGIN
  PERFORM cron.unschedule('compute_user_reputation_daily');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'compute_user_reputation_daily',
  '0 4 * * *',
  $cron$ SELECT public.compute_user_reputation_daily() $cron$
);
