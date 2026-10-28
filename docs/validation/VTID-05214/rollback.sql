-- VTID-05214 rollback: restore the 20261004120000 gate and append bodies, drop the policy columns and the PM tables.
BEGIN;
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
      ELSIF v_s.human_approved_by IS NULL THEN
        v_reason := 'not_human_approved';
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

CREATE OR REPLACE FUNCTION public.plan_sparring_append_round(p_session uuid, p_round jsonb, p_expected_round int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_s public.plan_sparring_sessions%ROWTYPE;
  v_count int;
BEGIN
  IF p_round IS NULL OR jsonb_typeof(p_round) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ROUND_MUST_BE_OBJECT');
  END IF;
  IF p_expected_round IS NULL OR p_expected_round < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'EXPECTED_ROUND_REQUIRED');
  END IF;

  SELECT * INTO v_s FROM public.plan_sparring_sessions WHERE id = p_session FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SESSION_NOT_FOUND');
  END IF;
  -- Frozen once approved or bound to a VTID: the evidence the approval was
  -- given on must not change afterwards.
  IF v_s.human_approved_by IS NOT NULL OR v_s.vtid IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SESSION_FROZEN');
  END IF;
  -- Concurrency: the row lock serializes appends; the second of two racing
  -- appends of the same round sees the first one's round and is refused.
  IF v_s.verdict <> 'in_progress' THEN
    RAISE EXCEPTION 'round_conflict: session % verdict is %, rounds can only be appended while in_progress',
      p_session, v_s.verdict
      USING ERRCODE = 'PS409';
  END IF;
  IF jsonb_array_length(v_s.rounds) + 1 <> p_expected_round THEN
    RAISE EXCEPTION 'round_conflict: session % has % round(s), expected round % cannot be appended',
      p_session, jsonb_array_length(v_s.rounds), p_expected_round
      USING ERRCODE = 'PS409';
  END IF;

  UPDATE public.plan_sparring_sessions
     SET rounds = rounds || jsonb_build_array(p_round)
   WHERE id = p_session
  RETURNING jsonb_array_length(rounds) INTO v_count;

  RETURN jsonb_build_object('ok', true, 'id', p_session, 'round_count', v_count);
END;
$$;

ALTER TABLE public.plan_sparring_sessions DROP CONSTRAINT IF EXISTS plan_sparring_sessions_policy_approval_check;
ALTER TABLE public.plan_sparring_sessions DROP CONSTRAINT IF EXISTS plan_sparring_sessions_approval_policy_check;
ALTER TABLE public.plan_sparring_sessions
  DROP COLUMN IF EXISTS policy_approval_rule,
  DROP COLUMN IF EXISTS policy_approved_at,
  DROP COLUMN IF EXISTS approval_policy;
DROP TABLE IF EXISTS public.pm_lease;
DROP TABLE IF EXISTS public.pm_digests;
COMMIT;
NOTIFY pgrst, 'reload schema';
