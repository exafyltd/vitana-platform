BEGIN;
-- Bridge period (owner instruction 2026-11-12): convergence is the machine approval of a plan.
-- The human approval (human_approved_by) and the policy approval are no longer required for a
-- CONVERGED session. An ESCALATED session is still refused. Plan hash and VTID binding are unchanged.
--
-- NOT APPLIED. This migration writes the shared database (staging and production use the same
-- Supabase project). Migrations stay human-approved (owner decision 2026-11-12): apply only
-- after the owner approves this file.
CREATE OR REPLACE FUNCTION public._plan_sparring_gate_eval(p_vtid text, p_metadata jsonb, p_actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mode    text;
  v_meta    jsonb := COALESCE(p_metadata, '{}'::jsonb);
  v_raw     text  := NULLIF(btrim(COALESCE(p_metadata, '{}'::jsonb)->>'sparring_id'), '');
  v_exempt  text  := NULLIF(btrim(COALESCE(p_metadata, '{}'::jsonb)->>'sparring_exempt_reason'), '');
  v_hash    text  := NULLIF(btrim(COALESCE(p_metadata, '{}'::jsonb)->>'plan_hash'), '');
  v_is_gov  boolean := (p_actor = 'vitana_governance_owner');
  v_sid     uuid;
  v_s       public.plan_sparring_sessions%ROWTYPE;
  v_outcome text;
  v_reason  text;
BEGIN
  -- Upsert path: the VTID already exists, this is not a new allocation.
  IF EXISTS (SELECT 1 FROM public.vtid_ledger l WHERE l.vtid = p_vtid) THEN
    RETURN jsonb_build_object('mode', NULL, 'outcome', 'existing', 'allow', true, 'metadata', p_metadata);
  END IF;

  v_mode := public._plan_sparring_mode();
  IF v_mode = 'off' THEN
    RETURN jsonb_build_object('mode', 'off', 'outcome', NULL, 'allow', true, 'metadata', p_metadata);
  END IF;

  IF v_raw IS NOT NULL THEN
    BEGIN
      v_sid := v_raw::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_sid := NULL;
      v_reason := 'sparring_id_not_uuid';
    END;

    IF v_sid IS NOT NULL THEN
      SELECT * INTO v_s FROM public.plan_sparring_sessions WHERE id = v_sid FOR UPDATE;
      IF NOT FOUND THEN
        v_reason := 'session_not_found';
      ELSIF v_s.verdict NOT IN ('converged', 'escalated') THEN
        v_reason := 'verdict_' || v_s.verdict;
      -- VTID-05214: an owner approval, or the policy approval of a CONVERGED
      -- session (converged-auto-v1). An escalated session needs the owner.
      ELSIF v_s.verdict <> 'converged' THEN
        v_reason := 'not_converged';
      ELSIF v_s.final_plan_hash IS NULL THEN
        v_reason := 'no_final_plan_hash';
      ELSIF v_hash IS NULL THEN
        v_reason := 'plan_hash_missing';
      ELSIF v_hash <> v_s.final_plan_hash THEN
        v_reason := 'plan_hash_mismatch';
      ELSIF v_s.vtid IS NOT NULL AND v_s.vtid <> p_vtid THEN
        v_reason := 'session_bound_to_other_vtid';
      ELSIF EXISTS (SELECT 1 FROM public.vtid_ledger l
                     WHERE l.metadata->>'sparring_id' = v_sid::text AND l.vtid <> p_vtid) THEN
        v_reason := 'sparring_id_already_used';
      ELSE
        v_outcome := 'ok';
        UPDATE public.plan_sparring_sessions SET vtid = p_vtid WHERE id = v_sid;
      END IF;
    END IF;
  END IF;

  IF v_outcome IS NULL THEN
    IF v_exempt IS NOT NULL AND v_is_gov THEN
      v_outcome := 'exempt';
    ELSIF v_raw IS NULL AND v_exempt IS NULL THEN
      v_outcome := 'missing';
    ELSE
      v_outcome := 'invalid';
      v_reason := COALESCE(v_reason, 'exempt_reason_without_governance_role');
    END IF;
  END IF;

  -- A sparring_id that did not verify is not kept under the indexed key, so
  -- the partial unique index can never reject a log-mode insert.
  IF v_outcome <> 'ok' AND v_raw IS NOT NULL THEN
    v_meta := (v_meta - 'sparring_id') || jsonb_build_object('sparring_id_unverified', v_raw);
  END IF;

  INSERT INTO public.plan_sparring_shadow_log (vtid, sparring_id, outcome, detail)
  VALUES (
    p_vtid, v_sid, v_outcome,
    jsonb_strip_nulls(jsonb_build_object(
      'mode', v_mode,
      'reason', v_reason,
      'actor', p_actor,
      'session_user', session_user,
      'raw_sparring_id', CASE WHEN v_sid IS NULL THEN v_raw END,
      'plan_hash', v_hash,
      'exempt_reason', v_exempt,
      'source', v_meta->>'source'
    ))
  );

  RETURN jsonb_build_object(
    'mode', v_mode,
    'outcome', v_outcome,
    'reason', v_reason,
    'allow', v_outcome IN ('ok', 'exempt'),
    'metadata', v_meta
  );
END;
$$;

COMMIT;
