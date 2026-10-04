-- =============================================================================
-- VTID-04868: Plan Sparring Gate — P1 database foundation, LOG MODE ONLY
-- =============================================================================
-- Owner decision 2026-10-03/04: every new plan is reviewed ping-pong by an
-- independent sparring partner BEFORE a VTID is allocated. This migration is
-- the database half of P1. It ships the gate in mode 'log': nothing is ever
-- blocked, every new VTID is recorded in plan_sparring_shadow_log with what
-- the gate WOULD have decided. Enforcement is implemented and tested
-- (supabase/tests/vtid_04868_plan_sparring_gate.test.sql) but switching
-- plan_sparring_config.mode to 'enforce' is a separate, reviewed migration.
--
-- What this migration does
--   1. Role vitana_governance_owner (NOLOGIN, created only if missing, never
--      granted to postgres / service_role / anon / authenticated here). It is
--      the only identity whose direct ledger INSERT can carry
--      metadata.sparring_exempt_reason (break-glass, owner decision 2).
--   2. plan_sparring_sessions — one sparring record per plan (rounds are
--      append-only through plan_sparring_append_round(); service_role has no
--      column privilege on `rounds`).
--      plan_sparring_config — single row (id = 1), mode 'off'|'log'|'enforce',
--      seeded 'log'. Changes only through a reviewed migration.
--      plan_sparring_shadow_log — one row per gate decision in 'log' mode.
--      RLS on all three; NO anon/authenticated policies or grants.
--   3. allocate_global_vtid(p_source, p_layer, p_module, p_sparring_id uuid
--      DEFAULT NULL) — the 3-arg version is DROPPED and the 4-arg version
--      CREATED in this one transaction. Body copied from
--      20260628120000_fix_allocate_global_vtid_seq_drift.sql; the only change
--      is that a non-null p_sparring_id is stored as metadata.sparring_id on
--      the shell ledger row (plus a pinned search_path). Every existing caller
--      sends the three named args and keeps working through the DEFAULT.
--      EXECUTE: service_role only (revoked from PUBLIC, anon, authenticated).
--   4. submit_plan_sparring_record(...) — attested tier (a session-run
--      partner). It cannot set a verdict or a human approval: records always
--      land as trust_tier 'attested', verdict 'pending_human_approval'.
--   5. Trigger trg_plan_sparring_check BEFORE INSERT ON vtid_ledger →
--      plan_sparring_check() → _plan_sparring_gate_eval():
--        * a row with NEW.vtid already exists (upsert path) → pass, no log;
--        * mode 'off' → pass, no log;
--        * valid  = metadata.sparring_id references a session with verdict
--          converged|escalated, human_approved_by NOT NULL, final_plan_hash
--          NOT NULL, and session.vtid NULL or = NEW.vtid (row locked FOR
--          UPDATE) → outcome 'ok', session.vtid bound to NEW.vtid;
--        * exempt = metadata.sparring_exempt_reason AND the inserting
--          current_user is vitana_governance_owner → outcome 'exempt';
--        * otherwise 'missing' (no sparring_id) or 'invalid'.
--        * LOG mode never raises: any internal error is caught and turned into
--          a WARNING, and the insert proceeds. A sparring_id that did not
--          verify is moved to metadata.sparring_id_unverified so the partial
--          unique index (6) can never reject a log-mode insert.
--        * ENFORCE mode raises unless 'ok' or 'exempt'.
--   6. Partial unique index vtid_ledger((metadata->>'sparring_id')) WHERE NOT
--      NULL — one sparring record binds at most one VTID. No existing ledger
--      row carries the key (it is new in this VTID), so the build cannot fail
--      on existing data and covers zero rows today.
--
-- ACCEPTED RESIDUAL (owner decision 1, 2026-10-04): on Supabase, migrations
-- and the SQL editor run as `postgres`, which can disable the trigger, update
-- the config row, or grant itself vitana_governance_owner. On Supabase these
-- are DETECTED (hourly gateway reconciler → vtid.plan_sparring.tamper_detected,
-- P1), not PREVENTED. On Aurora the roles are fully ours and the residual
-- closes there (see docs/AURORA-B3-RPC-PARITY-INVENTORY.md, VTID-04868
-- addendum: on Aurora the trigger is created only after CDC/final load stops).
--
-- Rollback: docs/validation/VTID-04868/rollback.sql (recreates the 3-arg
-- allocator; drops the trigger, functions and index).
-- Apply: RUN-MIGRATION.yml (workflow_dispatch), after approval. Idempotent.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Governance role (NOLOGIN). Idempotent; never granted to anyone here.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vitana_governance_owner') THEN
    CREATE ROLE vitana_governance_owner NOLOGIN NOINHERIT;
  END IF;
END $$;

COMMENT ON ROLE vitana_governance_owner IS
  'VTID-04868: Plan Sparring Gate break-glass identity (holder: platform owner). NOLOGIN. Only a direct vtid_ledger INSERT made as this role may carry metadata.sparring_exempt_reason; every such insert is logged and alerts P1. Must never be granted to service_role, anon or authenticated.';

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.plan_sparring_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id            uuid NOT NULL,
  plan_hash          text NOT NULL CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
  final_plan_hash    text CHECK (final_plan_hash IS NULL OR final_plan_hash ~ '^[0-9a-f]{64}$'),
  producer           text NOT NULL CHECK (btrim(producer) <> ''),
  change_class       text NOT NULL CHECK (change_class IN ('light', 'standard', 'expedited')),
  trust_tier         text NOT NULL CHECK (trust_tier IN ('gateway', 'attested')),
  base_ref           text,
  rounds             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rounds) = 'array'),
  verdict            text NOT NULL DEFAULT 'in_progress'
                     CHECK (verdict IN ('in_progress', 'converged', 'escalated', 'pending_human_approval')),
  escalation_reasons text[] DEFAULT '{}',
  model_log          jsonb DEFAULT '[]'::jsonb,
  human_approved_by  uuid,
  human_approved_at  timestamptz,
  approval_evidence  jsonb,
  vtid               text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plan_sparring_sessions_plan
  ON public.plan_sparring_sessions (plan_id, plan_hash);

COMMENT ON TABLE public.plan_sparring_sessions IS
  'VTID-04868: one Plan Sparring record per plan. rounds is append-only (plan_sparring_append_round); vtid is bound by the vtid_ledger BEFORE INSERT gate. Only the gateway approve endpoint (exafy_admin) sets human_approved_*.';

CREATE TABLE IF NOT EXISTS public.plan_sparring_config (
  id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode       text NOT NULL DEFAULT 'log' CHECK (mode IN ('off', 'log', 'enforce')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed once. ON CONFLICT DO NOTHING: re-running this migration must never
-- reset a mode a later reviewed migration has set.
INSERT INTO public.plan_sparring_config (id, mode) VALUES (1, 'log')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.plan_sparring_config IS
  'VTID-04868: single row (id=1). mode off|log|enforce for the vtid_ledger Plan Sparring gate. Change only through a reviewed migration; the gateway reconciler alerts on any change.';

CREATE TABLE IF NOT EXISTS public.plan_sparring_shadow_log (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  vtid        text,
  sparring_id uuid,
  outcome     text NOT NULL CHECK (outcome IN ('missing', 'invalid', 'ok', 'exempt')),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plan_sparring_shadow_log_created
  ON public.plan_sparring_shadow_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plan_sparring_shadow_log_outcome
  ON public.plan_sparring_shadow_log (outcome, created_at DESC);

COMMENT ON TABLE public.plan_sparring_shadow_log IS
  'VTID-04868: one row per new vtid_ledger insert evaluated by the Plan Sparring gate (modes log and enforce-allowed). Written only by _plan_sparring_gate_eval().';

-- updated_at touch for sessions
CREATE OR REPLACE FUNCTION public._plan_sparring_sessions_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_plan_sparring_sessions_touch ON public.plan_sparring_sessions;
CREATE TRIGGER trg_plan_sparring_sessions_touch
  BEFORE UPDATE ON public.plan_sparring_sessions
  FOR EACH ROW EXECUTE FUNCTION public._plan_sparring_sessions_touch();

-- RLS + grants. No anon/authenticated policy or grant, ever.
ALTER TABLE public.plan_sparring_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_sparring_config     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_sparring_shadow_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.plan_sparring_sessions   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.plan_sparring_config     FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.plan_sparring_shadow_log FROM PUBLIC, anon, authenticated, service_role;

-- Gateway (service_role): read everything; create sessions without rounds;
-- update everything except identity columns and rounds (append via RPC).
-- No DELETE anywhere.
GRANT SELECT ON public.plan_sparring_sessions TO service_role;
GRANT INSERT (id, plan_id, plan_hash, final_plan_hash, producer, change_class, trust_tier,
              base_ref, verdict, escalation_reasons, model_log, human_approved_by,
              human_approved_at, approval_evidence)
  ON public.plan_sparring_sessions TO service_role;
GRANT UPDATE (plan_hash, final_plan_hash, base_ref, verdict, escalation_reasons, model_log,
              human_approved_by, human_approved_at, approval_evidence, updated_at)
  ON public.plan_sparring_sessions TO service_role;
GRANT SELECT ON public.plan_sparring_config     TO service_role;
GRANT SELECT ON public.plan_sparring_shadow_log TO service_role;

-- Governance owner: may read and change the mode (DETECTED by the reconciler).
GRANT SELECT, UPDATE (mode, updated_at) ON public.plan_sparring_config TO vitana_governance_owner;

-- Explicit service_role / governance policies so the tables behave the same on
-- a Postgres where service_role lacks BYPASSRLS (Aurora).
DROP POLICY IF EXISTS plan_sparring_sessions_service_role ON public.plan_sparring_sessions;
CREATE POLICY plan_sparring_sessions_service_role ON public.plan_sparring_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS plan_sparring_config_service_role_read ON public.plan_sparring_config;
CREATE POLICY plan_sparring_config_service_role_read ON public.plan_sparring_config
  FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS plan_sparring_config_governance_owner ON public.plan_sparring_config;
CREATE POLICY plan_sparring_config_governance_owner ON public.plan_sparring_config
  FOR ALL TO vitana_governance_owner USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS plan_sparring_shadow_log_service_role_read ON public.plan_sparring_shadow_log;
CREATE POLICY plan_sparring_shadow_log_service_role_read ON public.plan_sparring_shadow_log
  FOR SELECT TO service_role USING (true);

-- Break-glass: the governance owner may INSERT a ledger row directly (and use
-- the sequence). It gets no UPDATE/DELETE on the ledger.
GRANT INSERT ON public.vtid_ledger TO vitana_governance_owner;
GRANT USAGE ON SEQUENCE public.global_vtid_seq TO vitana_governance_owner;
DROP POLICY IF EXISTS vtid_ledger_governance_owner_insert ON public.vtid_ledger;
CREATE POLICY vtid_ledger_governance_owner_insert ON public.vtid_ledger
  FOR INSERT TO vitana_governance_owner WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. allocate_global_vtid — 3-arg dropped, 4-arg created (same transaction)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.allocate_global_vtid(text, text, text);

CREATE OR REPLACE FUNCTION public.allocate_global_vtid(
    p_source TEXT DEFAULT 'api',
    p_layer TEXT DEFAULT 'DEV',
    p_module TEXT DEFAULT 'TASK',
    p_sparring_id UUID DEFAULT NULL
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
BEGIN
    -- Normalize inputs
    v_layer := UPPER(COALESCE(p_layer, 'DEV'));
    v_module := UPPER(COALESCE(p_module, 'TASK'));

    -- Step 1: Get next sequence number atomically.
    -- VTID-04868: body kept byte-for-byte equal to the LIVE allocator as of
    -- 2026-10-04 (plain nextval). The free-slot loop in migration
    -- 20260628120000 was never applied live and is NOT shipped here.
    v_num := nextval('global_vtid_seq');

    -- Format as VTID-XXXXX (5-digit zero-padded)
    v_vtid := 'VTID-' || LPAD(v_num::TEXT, 5, '0');

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
        END,
        NOW(),
        NOW()
    );

    -- Return the allocated VTID info
    RETURN QUERY SELECT v_vtid, v_num, v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_global_vtid(TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_global_vtid(TEXT, TEXT, TEXT, UUID) TO service_role;

COMMENT ON FUNCTION public.allocate_global_vtid(TEXT, TEXT, TEXT, UUID) IS
    'VTID-0542 / VTID-04868: Atomically allocates next FREE VTID and creates a shell entry in vtid_ledger (bounded skip-forward loop tolerates sequence drift). p_sparring_id (optional) is stored as metadata.sparring_id and verified by the Plan Sparring gate trigger.';

-- ---------------------------------------------------------------------------
-- 4. Attested-tier record submission and append-only rounds
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_plan_sparring_record(
  p_plan_id            uuid,
  p_plan_hash          text,
  p_producer           text,
  p_change_class       text,
  p_rounds             jsonb DEFAULT '[]'::jsonb,
  p_base_ref           text DEFAULT NULL,
  p_final_plan_hash    text DEFAULT NULL,
  p_model_log          jsonb DEFAULT '[]'::jsonb,
  p_escalation_reasons text[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.plan_sparring_sessions%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_plan_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PLAN_ID_REQUIRED');
  END IF;
  IF p_plan_hash IS NULL OR p_plan_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_PLAN_HASH');
  END IF;
  IF p_final_plan_hash IS NOT NULL AND p_final_plan_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_FINAL_PLAN_HASH');
  END IF;
  IF p_producer IS NULL OR btrim(p_producer) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PRODUCER_REQUIRED');
  END IF;
  IF p_change_class IS NULL OR p_change_class NOT IN ('light', 'standard', 'expedited') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CHANGE_CLASS');
  END IF;
  IF p_rounds IS NULL OR jsonb_typeof(p_rounds) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ROUNDS_MUST_BE_ARRAY');
  END IF;

  -- Idempotent: the same attested plan text submitted twice is one record.
  SELECT * INTO v_existing
    FROM public.plan_sparring_sessions
   WHERE plan_id = p_plan_id AND plan_hash = p_plan_hash AND trust_tier = 'attested'
   ORDER BY created_at
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'id', v_existing.id, 'duplicate', true,
                              'verdict', v_existing.verdict, 'vtid', v_existing.vtid);
  END IF;

  -- Attested records can never self-approve: tier, verdict and approval
  -- columns are fixed here, not taken from the caller.
  INSERT INTO public.plan_sparring_sessions (
    plan_id, plan_hash, final_plan_hash, producer, change_class, trust_tier,
    base_ref, rounds, verdict, escalation_reasons, model_log,
    human_approved_by, human_approved_at, approval_evidence
  ) VALUES (
    p_plan_id, p_plan_hash, p_final_plan_hash, btrim(p_producer), p_change_class, 'attested',
    p_base_ref, p_rounds, 'pending_human_approval', COALESCE(p_escalation_reasons, '{}'),
    COALESCE(p_model_log, '[]'::jsonb),
    NULL, NULL, NULL
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'duplicate', false,
                            'verdict', 'pending_human_approval', 'vtid', NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_plan_sparring_record(uuid, text, text, text, jsonb, text, text, jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_plan_sparring_record(uuid, text, text, text, jsonb, text, text, jsonb, text[]) TO service_role;

COMMENT ON FUNCTION public.submit_plan_sparring_record(uuid, text, text, text, jsonb, text, text, jsonb, text[]) IS
  'VTID-04868: attested tier. Stores a session-run sparring record as trust_tier=attested, verdict=pending_human_approval. Cannot set converged or human_approved_*; only the gateway approve endpoint can.';

CREATE OR REPLACE FUNCTION public.plan_sparring_append_round(p_session uuid, p_round jsonb)
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

  SELECT * INTO v_s FROM public.plan_sparring_sessions WHERE id = p_session FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SESSION_NOT_FOUND');
  END IF;
  -- Frozen once approved or bound to a VTID: the evidence the approval was
  -- given on must not change afterwards.
  IF v_s.human_approved_by IS NOT NULL OR v_s.vtid IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SESSION_FROZEN');
  END IF;

  UPDATE public.plan_sparring_sessions
     SET rounds = rounds || jsonb_build_array(p_round)
   WHERE id = p_session
  RETURNING jsonb_array_length(rounds) INTO v_count;

  RETURN jsonb_build_object('ok', true, 'id', p_session, 'round_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.plan_sparring_append_round(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_sparring_append_round(uuid, jsonb) TO service_role;

COMMENT ON FUNCTION public.plan_sparring_append_round(uuid, jsonb) IS
  'VTID-04868: the only write path for plan_sparring_sessions.rounds. Appends one round object verbatim; refuses once the session is approved or bound to a VTID.';

-- ---------------------------------------------------------------------------
-- 5. The gate
-- ---------------------------------------------------------------------------
-- Mode reader (definer, so the trigger can read the mode whatever role inserts).
CREATE OR REPLACE FUNCTION public._plan_sparring_mode()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((SELECT mode FROM public.plan_sparring_config WHERE id = 1), 'log');
$$;

-- Evaluation + shadow log + binding. SECURITY DEFINER so every inserting role
-- (postgres via the allocator, service_role, the governance owner) sees the
-- sessions and can write the log. p_actor is the INSERTING current_user, read
-- by the SECURITY INVOKER trigger below; a direct call with a forged p_actor
-- can at most write a shadow-log row (an 'exempt' row alerts P1) — it never
-- inserts a ledger row and never decides what the trigger does with one.
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

REVOKE ALL ON FUNCTION public._plan_sparring_mode() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) FROM PUBLIC, anon, authenticated;
-- Every role that can insert into vtid_ledger runs the trigger as itself.
GRANT EXECUTE ON FUNCTION public._plan_sparring_mode() TO service_role, vitana_governance_owner;
GRANT EXECUTE ON FUNCTION public._plan_sparring_gate_eval(text, jsonb, text) TO service_role, vitana_governance_owner;

-- Trigger function: SECURITY INVOKER on purpose, so current_user is the role
-- that actually inserts (the exempt path depends on it).
CREATE OR REPLACE FUNCTION public.plan_sparring_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_res  jsonb;
  v_mode text;
BEGIN
  BEGIN
    v_res := public._plan_sparring_gate_eval(NEW.vtid, NEW.metadata, current_user::text);
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      v_mode := public._plan_sparring_mode();
    EXCEPTION WHEN OTHERS THEN
      v_mode := 'log';
    END;
    IF v_mode = 'enforce' THEN
      RAISE;  -- fail closed when enforcing
    END IF;
    -- LOG MODE NEVER BLOCKS: surface the fault, let the insert proceed.
    RAISE WARNING 'plan_sparring_gate: evaluation failed for % (%), insert allowed in % mode',
      NEW.vtid, SQLERRM, v_mode;
    RETURN NEW;
  END;

  IF v_res->>'outcome' = 'existing' OR v_res->>'mode' = 'off' THEN
    RETURN NEW;
  END IF;

  IF v_res->>'mode' = 'enforce' AND NOT (v_res->>'allow')::boolean THEN
    RAISE EXCEPTION 'plan_sparring_gate: % has no approved Plan Sparring record (outcome %, reason %)',
      NEW.vtid, v_res->>'outcome', COALESCE(v_res->>'reason', 'no sparring_id')
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Spar the plan first (POST /api/v1/plans/spar), get it approved, then allocate with p_sparring_id.';
  END IF;

  IF NEW.metadata IS DISTINCT FROM (v_res->'metadata') AND v_res->'metadata' <> 'null'::jsonb THEN
    NEW.metadata := v_res->'metadata';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.plan_sparring_check() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.plan_sparring_check() IS
  'VTID-04868: Plan Sparring gate, BEFORE INSERT on vtid_ledger. Existing VTID (upsert) passes; mode off passes; log mode never raises and records ok|missing|invalid|exempt in plan_sparring_shadow_log; enforce mode raises unless ok or exempt.';

DROP TRIGGER IF EXISTS trg_plan_sparring_check ON public.vtid_ledger;
CREATE TRIGGER trg_plan_sparring_check
  BEFORE INSERT ON public.vtid_ledger
  FOR EACH ROW EXECUTE FUNCTION public.plan_sparring_check();

-- ---------------------------------------------------------------------------
-- 6. One sparring record binds at most one VTID
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS vtid_ledger_sparring_id_unique
  ON public.vtid_ledger ((metadata->>'sparring_id'))
  WHERE metadata->>'sparring_id' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. Read-only trigger status for the gateway reconciler (tamper detection)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.plan_sparring_trigger_status()
RETURNS TABLE (present boolean, tgenabled text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT true, t.tgenabled::text
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.vtid_ledger'::regclass
     AND t.tgname = 'trg_plan_sparring_check'
  UNION ALL
  SELECT false, NULL::text
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = 'public.vtid_ledger'::regclass
        AND t.tgname = 'trg_plan_sparring_check');
$$;

REVOKE ALL ON FUNCTION public.plan_sparring_trigger_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_sparring_trigger_status() TO service_role;

COMMENT ON FUNCTION public.plan_sparring_trigger_status() IS
  'VTID-04868: read-only status of trg_plan_sparring_check (present, tgenabled) for the gateway reconciler; tgenabled <> ''O'' means the gate was disabled.';

COMMIT;

NOTIFY pgrst, 'reload schema';
