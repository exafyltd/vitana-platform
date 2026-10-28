-- =============================================================================
-- Fix: activate_autopilot_recommendation fails with
--   "invalid input syntax for type bytea"
--
-- Root cause: v_spec_snapshot::text::bytea tries to interpret the JSON string
-- as a bytea literal (expecting \x hex or escape format). This fails because
-- JSON text like {"vtid_title":"..."} is not valid bytea encoding.
--
-- Fix: Use convert_to(text, 'UTF8') which properly converts text to its
-- byte representation.
-- =============================================================================

CREATE OR REPLACE FUNCTION activate_autopilot_recommendation(
  p_recommendation_id UUID,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rec RECORD;
  v_vtid TEXT;
  v_num BIGINT;
  v_spec_snapshot JSONB;
  v_checksum TEXT;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  -- Get the recommendation
  SELECT * INTO v_rec
  FROM autopilot_recommendations
  WHERE id = p_recommendation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Recommendation not found'
    );
  END IF;

  -- Idempotent: If already activated, return existing VTID
  IF v_rec.status = 'activated' AND v_rec.activated_vtid IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'vtid', v_rec.activated_vtid,
      'already_activated', true,
      'activated_at', v_rec.activated_at
    );
  END IF;

  -- Check if recommendation is in activatable state
  IF v_rec.status NOT IN ('new', 'snoozed') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format('Cannot activate recommendation in status: %s', v_rec.status)
    );
  END IF;

  -- Generate VTID using global sequence (digits only, compatible with worker runner)
  v_num := nextval('global_vtid_seq');
  v_vtid := 'VTID-' || LPAD(v_num::TEXT, 5, '0');

  -- Build spec snapshot from recommendation
  v_spec_snapshot := jsonb_build_object(
    'vtid_title', v_rec.title,
    'goal', v_rec.summary,
    'scope_in', ARRAY[v_rec.domain],
    'scope_out', ARRAY[]::TEXT[],
    'non_negotiables', ARRAY['Safety check required', 'User consent required'],
    'files_expected', ARRAY[]::TEXT[],
    'endpoints_expected', ARRAY[]::TEXT[],
    'tests', ARRAY['Unit tests', 'Integration tests'],
    'definition_of_done', ARRAY[
      'Implementation complete',
      'Tests passing',
      'Documentation updated',
      'Code reviewed'
    ],
    'source_recommendation_id', p_recommendation_id,
    'domain', v_rec.domain,
    'risk_level', v_rec.risk_level,
    'impact_score', v_rec.impact_score,
    'effort_score', v_rec.effort_score
  );

  -- Generate checksum for integrity verification
  -- FIX: use convert_to() instead of ::text::bytea cast
  v_checksum := encode(sha256(convert_to(v_spec_snapshot::text, 'UTF8')), 'hex');

  -- Update recommendation with activation data
  UPDATE autopilot_recommendations
  SET status = 'activated',
      activated_vtid = v_vtid,
      activated_at = v_now,
      spec_snapshot = v_spec_snapshot,
      spec_checksum = v_checksum,
      updated_at = v_now
  WHERE id = p_recommendation_id;

  -- Create VTID ledger entry (plain INSERT — VTID is freshly generated)
  INSERT INTO vtid_ledger (
    vtid,
    title,
    summary,
    status,
    layer,
    module,
    created_at,
    updated_at
  ) VALUES (
    v_vtid,
    v_rec.title,
    v_rec.summary,
    'scheduled',
    'autopilot',
    'recommendation',
    v_now,
    v_now
  );

  RETURN jsonb_build_object(
    'ok', true,
    'vtid', v_vtid,
    'recommendation_id', p_recommendation_id,
    'title', v_rec.title,
    'status', 'activated',
    'activated_at', v_now,
    'spec_checksum', v_checksum
  );
END;
$$;
