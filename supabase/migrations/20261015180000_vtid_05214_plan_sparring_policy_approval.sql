-- VTID-05214 — Project Manager Agent P1: policy approval of converged plans.
--
-- Owner decision 2026-10-14 (plan pm-agent v2 §4, Gate 1 "yes" 2026-10-15): a sparring session that CONVERGED
-- is approved by policy instead of by the owner — only when the session asked for it at creation
-- (approval_policy = 'converged-auto-v1', set by the gateway for PLAN-SPAR.yml), only by the gateway sparring
-- service, and never for an escalated session. Four touch points change together:
--   1. plan_sparring_sessions gains approval_policy, policy_approved_at, policy_approval_rule; a CHECK makes a
--      policy approval impossible on a session that is not converged or has no final plan hash;
--   2. _plan_sparring_gate_eval accepts the owner's approval OR a policy approval of a converged session
--      (body otherwise identical to 20261004120000);
--   3. plan_sparring_append_round freezes a session on either approval (body otherwise identical);
--   4. the gateway service treats a policy-approved session as approved (TypeScript, same PR).
-- Plus two Project Manager tables (P3/P4 use them): pm_digests (append-only digest/Gate-2 batch records) and
-- pm_lease (one row; a PM tick runs only while it holds the lease). RLS on, service_role only.
-- Additive; re-runnable. Rollback: docs/validation/VTID-05214/rollback.sql.

BEGIN;

-- 1. Columns + invariant -------------------------------------------------------------------------------------
ALTER TABLE public.plan_sparring_sessions
  ADD COLUMN IF NOT EXISTS approval_policy      text,
  ADD COLUMN IF NOT EXISTS policy_approved_at   timestamptz,
  ADD COLUMN IF NOT EXISTS policy_approval_rule text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_sparring_sessions_approval_policy_check') THEN
    ALTER TABLE public.plan_sparring_sessions ADD CONSTRAINT plan_sparring_sessions_approval_policy_check
      CHECK (approval_policy IS NULL OR approval_policy IN ('converged-auto-v1'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_sparring_sessions_policy_approval_check') THEN
    ALTER TABLE public.plan_sparring_sessions ADD CONSTRAINT plan_sparring_sessions_policy_approval_check
      CHECK (policy_approved_at IS NULL
             OR (verdict = 'converged'
                 AND final_plan_hash IS NOT NULL
                 AND approval_policy IS NOT NULL
                 AND policy_approval_rule = approval_policy));
  END IF;
END $$;

COMMENT ON COLUMN public.plan_sparring_sessions.policy_approved_at IS
  'VTID-05214: set only by the gateway sparring service when a session created with approval_policy converged (rule in policy_approval_rule). The gate accepts it like human_approved_by; an escalated session can never carry it (CHECK).';

GRANT INSERT (approval_policy) ON public.plan_sparring_sessions TO service_role;
GRANT UPDATE (policy_approved_at, policy_approval_rule) ON public.plan_sparring_sessions TO service_role;

-- 2. Gate -----------------------------------------------------------------------------------------------------
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
      ELSIF v_s.human_approved_by IS NULL
            AND NOT (v_s.policy_approved_at IS NOT NULL AND v_s.verdict = 'converged') THEN
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

REVOKE ALL ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) TO service_role, vitana_governance_owner;

-- 3. Round appends freeze on either approval -------------------------------------------------------------------
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
  IF v_s.human_approved_by IS NOT NULL OR v_s.policy_approved_at IS NOT NULL OR v_s.vtid IS NOT NULL THEN
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

REVOKE ALL ON FUNCTION public.plan_sparring_append_round(uuid, jsonb, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_sparring_append_round(uuid, jsonb, int) TO service_role;

-- 4. Project Manager tables ------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pm_digests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('decision', 'digest', 'gate2_batch')),
  mode        text NOT NULL CHECK (mode IN ('dry_run', 'live')),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pm_digests_kind_created ON public.pm_digests (kind, created_at DESC);
COMMENT ON TABLE public.pm_digests IS
  'VTID-05214 (used by VTID-05216/05217): Project Manager decisions, daily digests and Gate-2 batches. Append-only; service_role only.';

CREATE TABLE IF NOT EXISTS public.pm_lease (
  id          int PRIMARY KEY CHECK (id = 1),
  holder      text,
  expires_at  timestamptz NOT NULL DEFAULT 'epoch'
);
INSERT INTO public.pm_lease (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE public.pm_lease IS
  'VTID-05214: one row. A Project Manager tick acts only after UPDATE ... SET holder, expires_at WHERE expires_at < now() RETURNING succeeds, so several gateway tasks never act twice.';

ALTER TABLE public.pm_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_lease   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pm_digests FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.pm_lease   FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.pm_digests TO service_role;
GRANT SELECT, UPDATE (holder, expires_at) ON public.pm_lease TO service_role;
DROP POLICY IF EXISTS pm_digests_service_role ON public.pm_digests;
CREATE POLICY pm_digests_service_role ON public.pm_digests FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS pm_lease_service_role ON public.pm_lease;
CREATE POLICY pm_lease_service_role ON public.pm_lease FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;

NOTIFY pgrst, 'reload schema';
