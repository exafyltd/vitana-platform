-- =============================================================================
-- get_public_vitana_index — publicly-readable Vitana Index for profile cards
-- Date: 2026-04-24
--
-- Context: the "Profile Card" surface (Maxina portal, /u/{handle},
-- Profile Preview dialog) is what users share with the world. Up to now
-- it showed a hardcoded 742 or a hash-derived fake number. That is
-- unacceptable for a public surface.
--
-- This RPC returns the latest `score_total` from `vitana_index_scores`
-- for a given user_id. It is SECURITY DEFINER so the (unauthenticated /
-- logged-in-as-someone-else) caller can read another user's current
-- Index without tripping RLS. Returns NULL if the user has no Index
-- yet (baseline survey not completed).
--
-- Only the single top-line Index number is exposed — no raw health data,
-- no per-pillar breakdown, no features. Those stay RLS-protected.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_public_vitana_index(p_user_id uuid)
RETURNS TABLE (
  score_total INTEGER,
  tier_label  TEXT,
  date        DATE,
  model_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_score INTEGER;
  v_date  DATE;
  v_model TEXT;
  v_tier  TEXT;
BEGIN
  SELECT s.score_total, s.date, s.model_version
    INTO v_score, v_date, v_model
    FROM public.vitana_index_scores s
   WHERE s.user_id = p_user_id
   ORDER BY s.date DESC
   LIMIT 1;

  IF v_score IS NULL THEN
    RETURN;
  END IF;

  -- Tier ladder mirrors the frontend VITANA_INDEX_TIERS in lib/vitanaIndex.ts.
  v_tier := CASE
    WHEN v_score >= 800 THEN 'Elite'
    WHEN v_score >= 600 THEN 'Really good'
    WHEN v_score >= 500 THEN 'Strong'
    WHEN v_score >= 300 THEN 'Building'
    WHEN v_score >= 100 THEN 'Early'
    ELSE 'Starting'
  END;

  score_total := v_score;
  tier_label  := v_tier;
  date        := v_date;
  model_version := v_model;
  RETURN NEXT;
END;
$$;

-- Allow anyone (including anon) to call the function. Only a single scalar
-- number comes out, so public access is safe.
GRANT EXECUTE ON FUNCTION public.get_public_vitana_index(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.get_public_vitana_index(uuid) IS
  'Public top-line Vitana Index for profile cards. Returns the latest score_total + tier label. SECURITY DEFINER so callers can read another user''s Index without tripping RLS on vitana_index_scores. Opt-in visibility is enforced by the UI layer via profile.visibility.indexPublic.';

NOTIFY pgrst, 'reload schema';

COMMIT;
