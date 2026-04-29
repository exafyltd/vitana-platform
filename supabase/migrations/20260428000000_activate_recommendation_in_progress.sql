-- =============================================================================
-- Fix: activate_autopilot_recommendation lands tasks in SCHEDULED column
--      AND fails with 409 duplicate-key when the global VTID sequence has
--      drifted behind manually-inserted high-numbered VTIDs
--
-- Symptom (Operations → Tasks board):
--   1. User clicks "Activate" in the Autopilot popup. The new VTID card
--      appears in the SCHEDULED column instead of IN PROGRESS.
--   2. (2026-04-29) After cleanup of self-heal retry rows, every Activate
--      click returned `409: duplicate key value violates unique constraint
--      "vtid_ledger_vtid_unique"` for VTID-02055, VTID-02056, etc.
--
-- Root causes:
--   1. The RPC inserts vtid_ledger.status = 'scheduled'. The Tasks board
--      adapter in services/gateway/src/routes/tasks.ts maps that to the
--      SCHEDULED column. Activation means "start now" — the row should land
--      in IN_PROGRESS, not Scheduled limbo.
--   2. global_vtid_seq is only one of several VTID generators. The VAEA
--      project (VTID-02400-02409) inserted high-numbered VTIDs via its own
--      migration without advancing the sequence; the self-healing reconciler
--      generates VTIDs via MAX(vtid)+1 in createFreshVtidFromTriageReport
--      which also ignores the sequence. Result: the sequence emits numbers
--      (e.g. 2055) that already exist in vtid_ledger and the INSERT 409s.
--
-- Fixes:
--   1. INSERT with status = 'in_progress' so the card renders in IN PROGRESS
--      immediately. The route handler then enqueues execution
--      (dev_autopilot_executions) for dev_autopilot* findings via the bridge
--      added in the same change set.
--   2. setval() the sequence above the current MAX(vtid_number) so the next
--      nextval() can't collide. Done as a one-shot DO block at the bottom of
--      this migration. Future drift is structurally prevented by this RPC
--      now using a do/while loop that increments past any pre-existing VTID
--      before INSERTing — so even a fresh manual VTID inserted between the
--      sequence jump and the INSERT can't break activation.
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

COMMENT ON FUNCTION activate_autopilot_recommendation IS
  'Activate recommendation - creates VTID + spec snapshot. Sets vtid_ledger.status=in_progress so the Tasks board renders the card in IN PROGRESS. Skips past existing VTIDs to handle sequence drift.';

-- =============================================================================
-- One-shot: realign global_vtid_seq above the highest VTID currently in the
-- ledger so the next nextval() can't collide on the first try. The RPC's
-- skip-forward loop above is the durable fix; this just spares us a wasted
-- ~400 nextval() calls on the first activation post-deploy.
-- =============================================================================
DO $$
DECLARE
  v_max BIGINT;
BEGIN
  SELECT COALESCE(MAX((REGEXP_MATCH(vtid, '^VTID-(\d+)$'))[1]::BIGINT), 0)
    INTO v_max
    FROM vtid_ledger
   WHERE vtid ~ '^VTID-\d+$';
  -- Add a 100-row buffer so any manual VTIDs minted between this migration
  -- running and the first nextval() don't immediately re-collide.
  PERFORM setval('global_vtid_seq', GREATEST(v_max + 100, currval('global_vtid_seq')));
  RAISE NOTICE 'global_vtid_seq advanced to %, max ledger VTID was %', currval('global_vtid_seq'), v_max;
END $$;
