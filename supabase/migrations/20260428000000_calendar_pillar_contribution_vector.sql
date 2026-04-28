-- =============================================================================
-- Calendar Events: pillar + contribution_vector columns
--
-- Adds typed Vitana Index linkage to calendar_events so the frontend can stop
-- relying on heuristics (event_type → pillar guesses, "pillar:*" tags inside
-- wellness_tags). Both columns are nullable / backward-compatible — legacy
-- rows continue to work with the existing wellness_tags fallback.
--
-- pillar:             one of the 5 canonical Vitana pillars
-- contribution_vector: per-pillar Δ a completion adds to the Index, mirroring
--                     the same shape AutopilotRecommendation already uses
--                     ({ nutrition: number, hydration: number, ... }).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS pillar TEXT;

ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS contribution_vector JSONB;

-- ---------------------------------------------------------------------------
-- 2. Constraints
-- ---------------------------------------------------------------------------

-- Drop the constraint if it already exists (idempotent re-runs)
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_pillar;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_pillar
  CHECK (pillar IS NULL OR pillar IN (
    'nutrition', 'hydration', 'exercise', 'sleep', 'mental'
  ));

-- contribution_vector must be a JSON object whose keys are pillar names and
-- values are non-negative numbers. We enforce shape softly via a CHECK that
-- only validates the top-level keys; deeper validation lives at the API layer.
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS valid_contribution_vector;
ALTER TABLE public.calendar_events ADD CONSTRAINT valid_contribution_vector
  CHECK (
    contribution_vector IS NULL
    OR (
      jsonb_typeof(contribution_vector) = 'object'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_object_keys(contribution_vector) AS k
        WHERE k NOT IN ('nutrition', 'hydration', 'exercise', 'sleep', 'mental')
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Backfill from existing wellness_tags `pillar:*` entries (best-effort)
--
-- Existing producers may already write `pillar:nutrition` etc. into
-- wellness_tags. Extract the first such tag into the new column so frontend
-- consumers see a typed value immediately for already-tagged events.
-- ---------------------------------------------------------------------------

UPDATE public.calendar_events
SET pillar = sub.pillar_value
FROM (
  SELECT
    id,
    LOWER(SUBSTRING(tag FROM 8)) AS pillar_value
  FROM public.calendar_events,
       UNNEST(wellness_tags) AS tag
  WHERE tag ILIKE 'pillar:%'
    AND LOWER(SUBSTRING(tag FROM 8)) IN (
      'nutrition', 'hydration', 'exercise', 'sleep', 'mental'
    )
) AS sub
WHERE public.calendar_events.id = sub.id
  AND public.calendar_events.pillar IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------------

-- Pillar-filtered upcoming events (powers the "Today's Index pulse" strip
-- in the calendar popup and per-pillar contribution queries).
CREATE INDEX IF NOT EXISTS idx_calendar_events_pillar_upcoming
  ON public.calendar_events (user_id, pillar, start_time)
  WHERE pillar IS NOT NULL AND status != 'cancelled';

-- ---------------------------------------------------------------------------
-- 5. Comments
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN public.calendar_events.pillar IS
  'One of the 5 canonical Vitana pillars (nutrition / hydration / exercise / sleep / mental). NULL means the event does not contribute to a single pillar.';

COMMENT ON COLUMN public.calendar_events.contribution_vector IS
  'Per-pillar Δ a successful completion will add to the Vitana Index. Shape mirrors autopilot_recommendations.contribution_vector: { nutrition?: number, hydration?: number, exercise?: number, sleep?: number, mental?: number }.';
