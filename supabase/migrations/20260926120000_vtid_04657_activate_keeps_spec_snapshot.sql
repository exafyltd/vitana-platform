-- VTID-04657: activate_autopilot_recommendation merges into spec_snapshot
-- instead of replacing it.
--
-- Body is byte-identical to 20260428000000_activate_recommendation_in_progress.sql
-- (verified against the live function: md5 28457bc2eebf3146ae4842a16e872fd3)
-- except for the one merge statement before the checksum.

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
  SELECT * INTO v_rec
  FROM autopilot_recommendations
  WHERE id = p_recommendation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Recommendation not found');
  END IF;

  IF v_rec.status = 'activated' AND v_rec.activated_vtid IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'vtid', v_rec.activated_vtid,
      'already_activated', true,
      'activated_at', v_rec.activated_at
    );
  END IF;

  IF v_rec.status NOT IN ('new', 'snoozed') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format('Cannot activate recommendation in status: %s', v_rec.status)
    );
  END IF;

  -- Generate VTID. nextval() can collide with high-numbered VTIDs inserted
  -- by other code paths (VAEA migrations, self-heal createFreshVtid, etc.)
  -- that don't advance the sequence. Skip forward until we find a free slot.
  -- Bounded loop to fail loudly if the table is somehow full.
  FOR i IN 1..1000 LOOP
    v_num := nextval('global_vtid_seq');
    v_vtid := 'VTID-' || LPAD(v_num::TEXT, 5, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM vtid_ledger WHERE vtid = v_vtid);
  END LOOP;
  IF EXISTS (SELECT 1 FROM vtid_ledger WHERE vtid = v_vtid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'VTID generator could not find a free slot in 1000 tries');
  END IF;

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

  -- VTID-04657: keep what the producer wrote (scanner, file_path,
  -- proposed_files, intake, signal_type, ...). The safety gate reads those
  -- keys when Activate bridges the finding into Dev Autopilot; replacing the
  -- snapshot dropped them (e.g. the npm-audit package.json scope override and
  -- the feedback lane's proposed_files). Generic keys still win on conflict.
  v_spec_snapshot := COALESCE(v_rec.spec_snapshot, '{}'::jsonb) || v_spec_snapshot;

  v_checksum := encode(sha256(convert_to(v_spec_snapshot::text, 'UTF8')), 'hex');

  UPDATE autopilot_recommendations
  SET status = 'activated',
      activated_vtid = v_vtid,
      activated_at = v_now,
      spec_snapshot = v_spec_snapshot,
      spec_checksum = v_checksum,
      updated_at = v_now
  WHERE id = p_recommendation_id;

  -- Status starts at 'in_progress' (was 'scheduled' before this migration)
  -- so the Tasks board renders the card in the IN PROGRESS column the moment
  -- the operator clicks Activate.
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
    'in_progress',
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

