-- =============================================================================
-- VTID-04666 — Autopilot recommendations P1: remove known noise
-- (docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md §4 P1)
--
-- Three functions, each CREATE OR REPLACE with its signature unchanged, so
-- every existing GRANT stays in place. Byte-identical to the previous
-- definition except for the lines marked "VTID-04666".
--
-- 1. insert_autopilot_recommendation (previous: 20260519000000_BOOTSTRAP_
--    autopilot_alignment_fields.sql): a SYSTEM-WIDE (developer) fingerprint a
--    human rejected in the last 30 days is reported as a duplicate instead of
--    being inserted again. The dedupe used to look only at new/snoozed rows,
--    so a rejected oasis/roadmap/health/behavior signal came back on the next
--    run. Scoped to p_user_id IS NULL on purpose: personal (community) rows
--    keep their own 14-day REJECTED_COOLDOWN_DAYS rule in the TypeScript
--    pre-check (recommendation-generator.ts, VTID-03201); this migration does
--    not change what members see.
--
-- 2. get_autopilot_recommendations / get_autopilot_recommendations_count
--    (previous: 20260519000000 / 20260117120000): the no-role path the
--    Command Hub uses for an exafy admin excludes source_type
--    'operator_onramp'. Those rows are already-executed operator requests,
--    not recommendations (103 were sitting in status='new').
--
-- 3. cleanup_expired_autopilot_recommendations (previous: 20260117130000):
--    VTID-04666 gives dev_autopilot / dev_autopilot_impact findings an
--    expires_at for the first time. This function DELETEs expired status='new'
--    rows, and a DELETE cascades to dev_autopilot_plan_versions and
--    dev_autopilot_executions — the execution history the P4 success-rate
--    breaker needs. Developer findings are therefore excluded from the DELETE;
--    they already leave the lists by expiry and are archived by the daily
--    dev-autopilot-auto-archive job. Before this migration their expires_at
--    was NULL, so this exclusion keeps today's behaviour exactly.
--
-- Idempotent. No schema change, no data change.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. insert_autopilot_recommendation
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.insert_autopilot_recommendation(
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

  -- VTID-04666: a system-wide (developer) fingerprint rejected within the
  -- last 30 days stays blocked.
  IF p_user_id IS NULL THEN
    SELECT * INTO v_existing
    FROM autopilot_recommendations
    WHERE fingerprint = p_fingerprint
      AND status = 'rejected'
      AND user_id IS NULL
      AND updated_at > NOW() - INTERVAL '30 days'
    ORDER BY updated_at DESC
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true, 'duplicate', true,
        'existing_id', v_existing.id, 'existing_status', v_existing.status
      );
    END IF;
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

COMMENT ON FUNCTION public.insert_autopilot_recommendation(
  TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT,
  TEXT[], TEXT[], TEXT[], INTEGER, UUID, INTEGER, TEXT, TEXT
) IS 'Insert autopilot recommendation with mission-alignment fields. economic_axis + autonomy_level default to none/manual; trigger derives autonomy_level for direct-insert paths that bypass this RPC. VTID-04666: a system-wide fingerprint rejected within 30 days is reported as a duplicate.';

-- -----------------------------------------------------------------------------
-- 2a. get_autopilot_recommendations
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_autopilot_recommendations(
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
    -- VTID-04666: operator on-ramp rows are executed requests, not recommendations.
    AND ar.source_type IS DISTINCT FROM 'operator_onramp'
  ORDER BY ar.impact_score DESC, ar.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2b. get_autopilot_recommendations_count
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_autopilot_recommendations_count(
  p_user_id UUID DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO v_count
  FROM autopilot_recommendations
  WHERE status = 'new'
    AND (p_user_id IS NULL OR user_id IS NULL OR user_id = p_user_id)
    AND (snoozed_until IS NULL OR snoozed_until < NOW())
    -- VTID-04666: operator on-ramp rows are executed requests, not recommendations.
    AND source_type IS DISTINCT FROM 'operator_onramp';

  RETURN v_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. cleanup_expired_autopilot_recommendations
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cleanup_expired_autopilot_recommendations()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM autopilot_recommendations
  WHERE expires_at < NOW()
    AND status = 'new'
    -- VTID-04666: developer findings carry plan/execution history (FK ON
    -- DELETE CASCADE); they expire out of the lists and are archived, never
    -- deleted here.
    AND source_type IS DISTINCT FROM 'dev_autopilot'
    AND source_type IS DISTINCT FROM 'dev_autopilot_impact';

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'deleted', v_deleted
  );
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
