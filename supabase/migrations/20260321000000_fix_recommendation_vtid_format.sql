-- =============================================================================
-- Fix: activate_autopilot_recommendation generates hex VTIDs (e.g. VTID-0A640)
-- that are rejected by the worker runner validator (expects VTID-\d{4,5}).
--
-- Root cause: md5(random()) produces hex characters (0-9, a-f).
-- Fix: Use the global_vtid_seq sequence (same as allocate_global_vtid) to
-- generate digits-only VTIDs that pass validation.
--
-- Also migrates existing hex VTIDs to numeric format.
-- =============================================================================

-- Step 1: Migrate existing hex VTIDs to numeric format
-- For each hex VTID, allocate a new numeric VTID and update all references
DO $$
DECLARE
  v_row RECORD;
  v_new_vtid TEXT;
  v_num BIGINT;
BEGIN
  FOR v_row IN
    SELECT vtid FROM vtid_ledger
    WHERE vtid ~ '^VTID-[0-9A-Fa-f]+$'
      AND vtid ~ '[A-Fa-f]'
    ORDER BY created_at ASC
  LOOP
    -- Allocate new numeric VTID from global sequence
    v_num := nextval('global_vtid_seq');
    v_new_vtid := 'VTID-' || LPAD(v_num::TEXT, 5, '0');

    RAISE NOTICE 'Migrating % -> %', v_row.vtid, v_new_vtid;

    -- Update vtid_ledger
    UPDATE vtid_ledger SET vtid = v_new_vtid, updated_at = NOW()
    WHERE vtid = v_row.vtid;

    -- Update oasis_events
    UPDATE oasis_events SET vtid = v_new_vtid
    WHERE vtid = v_row.vtid;

    -- Update autopilot_recommendations
    UPDATE autopilot_recommendations SET activated_vtid = v_new_vtid
    WHERE activated_vtid = v_row.vtid;

    -- Update oasis_specs
    UPDATE oasis_specs SET vtid = v_new_vtid
    WHERE vtid = v_row.vtid;
  END LOOP;
END;
$$;

-- Step 2: Recreate activate_autopilot_recommendation with numeric VTID generation
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
  v_checksum := encode(sha256(v_spec_snapshot::text::bytea), 'hex');

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
