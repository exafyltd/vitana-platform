-- =============================================================================
-- Mission Alignment Fields for Autopilot Recommendations
-- Date: 2026-05-11
-- Governance contract: docs/GOVERNANCE/ULTIMATE-GOAL.md (included in this PR)
--
-- Adds two columns to autopilot_recommendations so every recommendation can
-- declare HOW it serves the Ultimate Goal:
--   - economic_axis   : longevity economy axis advanced (or 'none')
--   - autonomy_level  : delivery model (manual / assisted / auto_approved / self_healing)
--
-- pillar_impact is NOT a new column — it is derived at read time from the
-- existing contribution_vector JSONB (populated by trigger on insert from
-- source_ref, see 20260423150000_vitana_index_contribution_vector.sql).
--
-- A BEFORE INSERT trigger ensures direct INSERT paths (dev-autopilot.ts,
-- dev-autopilot-synthesis.ts) that bypass the insert_autopilot_recommendation
-- RPC still get a correct autonomy_level derived from source_type +
-- auto_exec_eligible.
--
-- Idempotent throughout: IF NOT EXISTS, DROP IF EXISTS, CREATE OR REPLACE.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Columns
-- -----------------------------------------------------------------------------
ALTER TABLE public.autopilot_recommendations
  ADD COLUMN IF NOT EXISTS economic_axis TEXT NOT NULL DEFAULT 'none'
    CHECK (economic_axis IN ('find_match', 'marketplace', 'income_generation', 'business_formation', 'none'));

ALTER TABLE public.autopilot_recommendations
  ADD COLUMN IF NOT EXISTS autonomy_level TEXT NOT NULL DEFAULT 'manual'
    CHECK (autonomy_level IN ('manual', 'assisted', 'auto_approved', 'self_healing'));

COMMENT ON COLUMN public.autopilot_recommendations.economic_axis IS
  'Longevity economy axis advanced. Read by index-pillar-weighter economic_boost gate. See docs/GOVERNANCE/ULTIMATE-GOAL.md.';
COMMENT ON COLUMN public.autopilot_recommendations.autonomy_level IS
  'Delivery model. NOT a ranking input — autonomy is a delivery property, not a desirability property.';

-- -----------------------------------------------------------------------------
-- 2. Autonomy-level defaulting trigger
--    Direct INSERT paths (dev-autopilot.ts, dev-autopilot-synthesis.ts) bypass
--    the RPC, so we derive autonomy_level from source_type + auto_exec_eligible
--    at the table level. Only overrides the column default ('manual'), so
--    callers who set autonomy_level explicitly to anything other than 'manual'
--    are respected.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vitana_autopilot_autonomy_level_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.autonomy_level = 'manual'
     AND NEW.source_type IN ('dev_autopilot', 'dev_autopilot_impact')
     AND NEW.auto_exec_eligible = TRUE
  THEN
    NEW.autonomy_level := 'auto_approved';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_autopilot_recommendations_autonomy_level
  ON public.autopilot_recommendations;

CREATE TRIGGER trg_autopilot_recommendations_autonomy_level
  BEFORE INSERT ON public.autopilot_recommendations
  FOR EACH ROW
  EXECUTE FUNCTION public.vitana_autopilot_autonomy_level_trigger();

COMMENT ON FUNCTION public.vitana_autopilot_autonomy_level_trigger() IS
  'BEFORE INSERT: derives autonomy_level=auto_approved from source_type IN (dev_autopilot, dev_autopilot_impact) + auto_exec_eligible=TRUE, when autonomy_level is at default. Self-healing for direct-insert paths that bypass the insert_autopilot_recommendation RPC.';

-- -----------------------------------------------------------------------------
-- 3. Backfill existing rows (covers both dev_autopilot and dev_autopilot_impact)
-- -----------------------------------------------------------------------------
UPDATE public.autopilot_recommendations
SET autonomy_level = 'auto_approved'
WHERE source_type IN ('dev_autopilot', 'dev_autopilot_impact')
  AND auto_exec_eligible = TRUE
  AND autonomy_level = 'manual';

-- -----------------------------------------------------------------------------
-- 4. Partial indexes for future Command Hub Mission Alignment filter views
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_economic_axis
  ON public.autopilot_recommendations(economic_axis, status, created_at DESC)
  WHERE economic_axis <> 'none';

CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_autonomy_level
  ON public.autopilot_recommendations(autonomy_level, status, created_at DESC)
  WHERE autonomy_level <> 'manual';

-- -----------------------------------------------------------------------------
-- 5. Recreate insert_autopilot_recommendation
--    Drop BOTH historical overloads (14-param original, 16-param current) so
--    we end with exactly one canonical 18-param function. Re-GRANT after.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.insert_autopilot_recommendation(
  TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT,
  TEXT[], TEXT[], TEXT[], INTEGER
);
DROP FUNCTION IF EXISTS public.insert_autopilot_recommendation(
  TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT,
  TEXT[], TEXT[], TEXT[], INTEGER, UUID, INTEGER
);

CREATE FUNCTION public.insert_autopilot_recommendation(
  p_title TEXT,
  p_summary TEXT,
  p_domain TEXT,
  p_risk_level TEXT,
  p_impact_score INTEGER,
  p_effort_score INTEGER,
  p_source_type TEXT,
  p_source_ref TEXT,
  p_fingerprint TEXT,
  p_run_id TEXT,
  p_suggested_files TEXT[] DEFAULT '{}',
  p_suggested_endpoints TEXT[] DEFAULT '{}',
  p_suggested_tests TEXT[] DEFAULT '{}',
  p_expires_days INTEGER DEFAULT 30,
  p_user_id UUID DEFAULT NULL,
  p_time_estimate_seconds INTEGER DEFAULT NULL,
  p_economic_axis TEXT DEFAULT 'none',
  p_autonomy_level TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing RECORD;
  v_id UUID;
BEGIN
  SELECT * INTO v_existing
  FROM autopilot_recommendations
  WHERE fingerprint = p_fingerprint
    AND status IN ('new', 'snoozed')
    AND ((user_id IS NULL AND p_user_id IS NULL) OR user_id = p_user_id)
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true,
      'existing_id', v_existing.id, 'existing_status', v_existing.status
    );
  END IF;

  INSERT INTO autopilot_recommendations (
    title, summary, domain, risk_level, impact_score, effort_score,
    source_type, source_ref, fingerprint, run_id,
    suggested_files, suggested_endpoints, suggested_tests,
    expires_at, status, user_id, time_estimate_seconds,
    economic_axis, autonomy_level
  ) VALUES (
    p_title, p_summary, p_domain, p_risk_level, p_impact_score, p_effort_score,
    p_source_type, p_source_ref, p_fingerprint, p_run_id,
    p_suggested_files, p_suggested_endpoints, p_suggested_tests,
    NOW() + (p_expires_days || ' days')::INTERVAL,
    'new', p_user_id, p_time_estimate_seconds,
    p_economic_axis, p_autonomy_level
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'id', v_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.insert_autopilot_recommendation(
  TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT,
  TEXT[], TEXT[], TEXT[], INTEGER, UUID, INTEGER, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.insert_autopilot_recommendation(
  TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT,
  TEXT[], TEXT[], TEXT[], INTEGER, UUID, INTEGER, TEXT, TEXT
) IS 'Insert autopilot recommendation with mission-alignment fields. economic_axis + autonomy_level default to none/manual; trigger derives autonomy_level for direct-insert paths that bypass this RPC.';

-- -----------------------------------------------------------------------------
-- 6. Recreate get_autopilot_recommendations
--    RETURNS TABLE shape changed (added 3 columns), so DROP first.
--    Re-GRANT to both service_role and authenticated to match prior behavior.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_autopilot_recommendations(TEXT[], INTEGER, INTEGER, UUID);

CREATE FUNCTION public.get_autopilot_recommendations(
  p_status TEXT[] DEFAULT ARRAY['new'],
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0,
  p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  summary TEXT,
  domain TEXT,
  risk_level TEXT,
  impact_score INTEGER,
  effort_score INTEGER,
  status TEXT,
  activated_vtid TEXT,
  created_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  time_estimate_seconds INTEGER,
  economic_axis TEXT,
  autonomy_level TEXT,
  contribution_vector JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ar.id, ar.title, ar.summary, ar.domain, ar.risk_level,
    ar.impact_score, ar.effort_score, ar.status, ar.activated_vtid,
    ar.created_at, ar.activated_at, ar.time_estimate_seconds,
    ar.economic_axis, ar.autonomy_level, ar.contribution_vector
  FROM autopilot_recommendations ar
  WHERE ar.status = ANY(p_status)
    AND (p_user_id IS NULL OR ar.user_id IS NULL OR ar.user_id = p_user_id)
    AND (ar.snoozed_until IS NULL OR ar.snoozed_until < NOW())
  ORDER BY ar.impact_score DESC, ar.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_autopilot_recommendations(TEXT[], INTEGER, INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_autopilot_recommendations(TEXT[], INTEGER, INTEGER, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
