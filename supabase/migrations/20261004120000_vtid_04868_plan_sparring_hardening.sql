-- =============================================================================
-- VTID-04868: Plan Sparring Gate — hardening (review findings on PR #3899)
-- =============================================================================
-- Follows 20261004110000_vtid_04868_plan_sparring_gate.sql (applied live in
-- LOG mode on 2026-10-04 and NOT edited here). Gate mode stays as it is:
-- this migration never touches plan_sparring_config.
--
-- What this migration does (one transaction, idempotent):
--   1. allocate_global_vtid — the 4-arg version is DROPPED and a 5-arg version
--      CREATED:
--        allocate_global_vtid(p_source, p_layer, p_module,
--                             p_sparring_id uuid DEFAULT NULL,
--                             p_plan_hash text DEFAULT NULL)
--      * p_plan_hash (when given) is stored as metadata.plan_hash next to
--        metadata.sparring_id, so the gate can bind the VTID to the exact
--        plan text the owner approved (finding 2).
--      * The bounded collision-skipping loop from
--        20260628120000_fix_allocate_global_vtid_seq_drift.sql is restored:
--        up to 1000 nextval() draws until a free VTID-XXXXX is found, else
--        unique_violation (finding 3). The 20261004110000 body used a plain
--        nextval, which 409s whenever global_vtid_seq has drifted behind an
--        out-of-band VTID.
--      * Shell-row shape and allocator_version 'VTID-0542' unchanged.
--      * Every existing caller (3 named args, or 4 with p_sparring_id) keeps
--        working through the DEFAULTs.
--      * EXECUTE: service_role only (revoked from PUBLIC, anon, authenticated).
--   2. _plan_sparring_gate_eval — CREATE OR REPLACE. A sparring_id is valid
--      only when NEW.metadata->>'plan_hash' equals the session's
--      final_plan_hash. Missing → reason 'plan_hash_missing', different →
--      'plan_hash_mismatch'; both are outcome 'invalid'. LOG mode still never
--      raises, and an unverified id is still moved to
--      metadata.sparring_id_unverified (finding 2).
--   3. plan_sparring_append_round — the 2-arg version is DROPPED and a 3-arg
--      version CREATED: (p_session uuid, p_round jsonb, p_expected_round int).
--      Under SELECT … FOR UPDATE it raises SQLSTATE 'PS409' ('round_conflict')
--      unless jsonb_array_length(rounds) + 1 = p_expected_round AND the
--      session verdict is still 'in_progress' — two concurrent appends of the
--      same round can no longer both land (finding 4). The gateway service
--      only ever appends while the verdict is 'in_progress' (create → round 1
--      on a fresh session; POST /:id/rounds requires 'in_progress').
--      EXECUTE: service_role only.
--
-- Findings 1 (service_role has no INSERT grant on `rounds`) and 5 (reconciler
-- paging) are gateway-only fixes; nothing in the database changes for them.
--
-- Rollback: docs/validation/VTID-04868/rollback.sql (reverses BOTH VTID-04868
-- migrations and recreates the live pre-VTID-04868 3-arg allocator).
-- Apply: RUN-MIGRATION.yml (workflow_dispatch), after approval.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. allocate_global_vtid — 4-arg dropped, 5-arg created (same transaction)
-- ---------------------------------------------------------------------------
-- The 3-arg drop is a no-op after 20261004110000; kept so a database that
-- somehow still carries it never ends up with an ambiguous overload.
DROP FUNCTION IF EXISTS public.allocate_global_vtid(text, text, text);
DROP FUNCTION IF EXISTS public.allocate_global_vtid(text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.allocate_global_vtid(
    p_source TEXT DEFAULT 'api',
    p_layer TEXT DEFAULT 'DEV',
    p_module TEXT DEFAULT 'TASK',
    p_sparring_id UUID DEFAULT NULL,
    p_plan_hash TEXT DEFAULT NULL
)
RETURNS TABLE(vtid TEXT, num BIGINT, id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_num BIGINT;
    v_vtid TEXT;
    v_id TEXT;
    v_layer TEXT;
    v_module TEXT;
    v_found BOOLEAN := false;
BEGIN
    -- Normalize inputs
    v_layer := UPPER(COALESCE(p_layer, 'DEV'));
    v_module := UPPER(COALESCE(p_module, 'TASK'));

    -- Step 1: Find the next FREE sequence number.
    -- nextval() can hand back a value that already exists in vtid_ledger when
    -- the sequence has drifted behind out-of-band writers (self-heal MAX+1,
    -- VAEA migrations, etc.). Skip forward until we land on a free slot.
    -- Bounded so we fail loudly rather than spin forever.
    FOR i IN 1..1000 LOOP
        v_num := nextval('global_vtid_seq');
        v_vtid := 'VTID-' || LPAD(v_num::TEXT, 5, '0');
        IF NOT EXISTS (SELECT 1 FROM vtid_ledger WHERE vtid_ledger.vtid = v_vtid) THEN
            v_found := true;
            EXIT;
        END IF;
    END LOOP;

    IF NOT v_found THEN
        RAISE EXCEPTION 'allocate_global_vtid: no free VTID slot found in 1000 tries (sequence at %)', v_num
            USING ERRCODE = 'unique_violation';
    END IF;

    -- Step 2: Generate UUID for the row
    v_id := gen_random_uuid()::TEXT;

    -- Step 3: Insert shell entry into vtid_ledger (same shape as before)
    INSERT INTO vtid_ledger (
        id,
        vtid,
        title,
        status,
        tenant,
        layer,
        module,
        task_family,
        task_type,
        summary,
        description,
        is_test,
        metadata,
        created_at,
        updated_at
    ) VALUES (
        v_id,
        v_vtid,
        'Allocated - Pending Title',  -- placeholder title
        'allocated',                   -- special status for shell entries
        'vitana',                      -- default tenant
        v_layer,                       -- layer
        v_module,                      -- module
        v_layer,                       -- task_family for backwards compat
        v_module,                      -- task_type for backwards compat
        '',                            -- empty summary
        '',                            -- empty description
        false,                         -- not a test
        jsonb_build_object(
            'source', p_source,
            'allocated_at', NOW()::TEXT,
            'allocator_version', 'VTID-0542'
        ) || CASE
            -- VTID-04868: bind the Plan Sparring record. The vtid_ledger
            -- BEFORE INSERT gate verifies it (and, in log mode, never blocks).
            WHEN p_sparring_id IS NOT NULL
              THEN jsonb_build_object('sparring_id', p_sparring_id::TEXT)
            ELSE '{}'::jsonb
        END || CASE
            -- VTID-04868 hardening: the approved plan's hash; the gate
            -- requires it to equal the session's final_plan_hash.
            WHEN p_plan_hash IS NOT NULL
              THEN jsonb_build_object('plan_hash', p_plan_hash)
            ELSE '{}'::jsonb
        END,
        NOW(),
        NOW()
    );

    -- Return the allocated VTID info
    RETURN QUERY SELECT v_vtid, v_num, v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_global_vtid(TEXT, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_global_vtid(TEXT, TEXT, TEXT, UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.allocate_global_vtid(TEXT, TEXT, TEXT, UUID, TEXT) IS
    'VTID-0542 / VTID-04868: Atomically allocates the next FREE VTID (bounded 1000-step skip-forward loop tolerates sequence drift) and creates a shell entry in vtid_ledger. p_sparring_id and p_plan_hash (optional) are stored as metadata.sparring_id / metadata.plan_hash and verified by the Plan Sparring gate trigger.';

-- ---------------------------------------------------------------------------
-- 2. The gate: a sparring_id binds only with the approved plan's hash
-- ---------------------------------------------------------------------------
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

REVOKE ALL ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) TO service_role, vitana_governance_owner;

-- ---------------------------------------------------------------------------
-- 3. Round appends: expected round number, serialized under FOR UPDATE
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.plan_sparring_append_round(uuid, jsonb);

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

REVOKE ALL ON FUNCTION public.plan_sparring_append_round(uuid, jsonb, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_sparring_append_round(uuid, jsonb, int) TO service_role;

COMMENT ON FUNCTION public.plan_sparring_append_round(uuid, jsonb, int) IS
  'VTID-04868: the only write path for plan_sparring_sessions.rounds. Appends one round object verbatim under a row lock; raises SQLSTATE PS409 (round_conflict) unless the session is in_progress and p_expected_round = current round count + 1; refuses once the session is approved or bound to a VTID.';

COMMIT;

NOTIFY pgrst, 'reload schema';
