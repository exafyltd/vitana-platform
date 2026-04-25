-- VTID-01952 — Memory Identity Lock + Provenance Closure (Phase 0)
--
-- DEFENSE IN DEPTH FOR THE MARIA → KEMAL CLASS OF BUG.
--
-- Problem: today, ORB voice / Cognee extraction can write fake user identity
-- facts (name, birthday, gender, etc.) into memory_facts via write_fact() RPC
-- with provenance_source='assistant_inferred'. Subsequent brain reads then
-- believe the wrong fact ("because you told me so").
--
-- Fix at the DB layer: a BEFORE INSERT/UPDATE trigger on memory_facts that
-- rejects any write to an identity-class fact_key unless provenance_source
-- comes from an authorized UI surface (Profile/Settings/Memory Garden UI/
-- Onboarding/Baseline Survey) or a system actor (signup trigger / admin).
--
-- Application code (services/gateway/src/services/memory-identity-lock.ts)
-- enforces the same rule at the chokepoint — this trigger is belt-and-suspenders
-- so even direct service-role SQL writes cannot bypass.
--
-- Plan reference: /home/dstev/.claude/plans/the-vitana-system-has-wild-puffin.md
--                 (Part 1.5 Identity Invariants)

BEGIN;

-- ============================================================================
-- 1. The identity-locked fact_keys + authorized provenance sources
--    Stored as immutable functions so they can be referenced from triggers,
--    application code (via Supabase RPC), and tests without drift.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.identity_locked_fact_keys()
RETURNS TEXT[]
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT ARRAY[
    -- Name
    'user_first_name',
    'user_last_name',
    'user_display_name',
    'user_full_name',
    -- Birth
    'user_date_of_birth',
    'user_birthday',
    -- Identity attributes
    'user_gender',
    'user_pronouns',
    'user_marital_status',
    -- Contact
    'user_email',
    'user_phone',
    -- Address
    'user_country',
    'user_city',
    'user_address',
    -- Locale + role
    'user_locale',
    'user_account_type',
    'user_role',
    'user_tenant_id'
  ]::TEXT[];
$$;

COMMENT ON FUNCTION public.identity_locked_fact_keys() IS
  'Identity-class fact_keys that cannot be written from voice/inference. Mirrors IDENTITY_LOCKED_KEYS in services/gateway/src/services/memory-identity-lock.ts. CI lint enforces sync.';


CREATE OR REPLACE FUNCTION public.identity_authorized_sources()
RETURNS TEXT[]
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT ARRAY[
    'user_stated_via_settings',
    'user_stated_via_memory_garden_ui',
    'user_stated_via_onboarding',
    'user_stated_via_baseline_survey',
    'admin_correction',
    'system_provision'
  ]::TEXT[];
$$;

COMMENT ON FUNCTION public.identity_authorized_sources() IS
  'provenance_source values authorized to write identity-locked fact_keys. These correspond to legitimate UI surfaces and system flows; voice/inference paths use other values and are blocked.';


-- ============================================================================
-- 2. Trigger function: enforce identity lock on memory_facts
--    Fires BEFORE INSERT or BEFORE UPDATE OF (the columns that matter).
--    Allows: provenance_source ∈ identity_authorized_sources()
--    Blocks: anything else when fact_key ∈ identity_locked_fact_keys()
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_identity_lock_memory_facts()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_locked_keys      TEXT[] := public.identity_locked_fact_keys();
  v_authorized       TEXT[] := public.identity_authorized_sources();
  v_is_locked_key    BOOLEAN;
  v_is_authorized    BOOLEAN;
BEGIN
  v_is_locked_key := NEW.fact_key = ANY(v_locked_keys);

  IF NOT v_is_locked_key THEN
    -- Not an identity-class key: allow normally.
    RETURN NEW;
  END IF;

  -- This IS an identity-class key. The provenance must be authorized.
  v_is_authorized := NEW.provenance_source IS NOT NULL
                  AND NEW.provenance_source = ANY(v_authorized);

  IF v_is_authorized THEN
    -- Authorized UI/system path: allow.
    RETURN NEW;
  END IF;

  -- Reject. The application broker (memory-identity-lock.ts) usually catches
  -- this earlier; reaching the DB trigger means either a bypass attempt or
  -- a writer that hasn't been wired through the broker yet.
  RAISE EXCEPTION
    'identity_locked: fact_key=% cannot be written with provenance_source=% (authorized: %). Use the Profile/Settings UI to change identity-class facts.',
    NEW.fact_key,
    COALESCE(NEW.provenance_source, '<null>'),
    array_to_string(v_authorized, ', ')
  USING
    ERRCODE = 'check_violation',
    HINT    = 'Hard-locked identity facts (name, DOB, gender, email, etc.) can only be changed via authorized UI surfaces. See CLAUDE.md Part 1.5 — Identity Invariants.',
    SCHEMA  = 'public',
    TABLE   = 'memory_facts',
    COLUMN  = 'fact_key';
END;
$$;

COMMENT ON FUNCTION public.enforce_identity_lock_memory_facts() IS
  'BEFORE INSERT/UPDATE trigger function: blocks writes to identity-class fact_keys from unauthorized provenance sources. Defense-in-depth for memory-identity-lock.ts.';


-- ============================================================================
-- 3. Bind the trigger to memory_facts
--    Drop-and-recreate is the idempotent pattern for triggers on this codebase.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_enforce_identity_lock_memory_facts ON public.memory_facts;

CREATE TRIGGER trg_enforce_identity_lock_memory_facts
  BEFORE INSERT OR UPDATE OF fact_key, fact_value, provenance_source
  ON public.memory_facts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_identity_lock_memory_facts();


-- ============================================================================
-- 4. Sanity check: existing rows for locked keys with unauthorized provenance
--    Surface (don't delete) any pre-existing bad data so we know the size of
--    the problem. Application code (Phase 0 brain guardrails) will trust
--    app_users canonical first, ignoring memory_facts mirror — so existing
--    bad rows can't poison new sessions even before cleanup.
-- ============================================================================

DO $$
DECLARE
  v_bad_rows BIGINT;
BEGIN
  SELECT count(*)
    INTO v_bad_rows
    FROM public.memory_facts
   WHERE fact_key = ANY(public.identity_locked_fact_keys())
     AND superseded_by IS NULL
     AND ( provenance_source IS NULL
           OR provenance_source NOT IN (SELECT unnest(public.identity_authorized_sources())) );

  IF v_bad_rows > 0 THEN
    RAISE NOTICE 'VTID-01952 Identity Lock: % existing memory_facts row(s) for identity-class keys have unauthorized provenance_source. Brain prompt Guardrail A reads from app_users canonical, so these will not poison new sessions. Cleanup query: SELECT * FROM memory_facts WHERE fact_key = ANY(identity_locked_fact_keys()) AND (provenance_source IS NULL OR provenance_source NOT IN (SELECT unnest(identity_authorized_sources())));', v_bad_rows;
  ELSE
    RAISE NOTICE 'VTID-01952 Identity Lock: no pre-existing unauthorized identity rows found. Clean state.';
  END IF;
END $$;


-- ============================================================================
-- 5. NOTE on app_users defense-in-depth (deferred to follow-up PR)
--
--    The plan also calls for a parallel trigger on app_users to block updates
--    to identity columns (first_name, date_of_birth, gender, ...) from
--    unauthorized actors. That trigger is NOT shipped here because:
--
--    1. The actual Maria→Kemal attack vector is via memory_facts (Cognee /
--       inference write_fact()), which is fully closed by this trigger.
--    2. app_users today is updated by service-role calls from auth.ts (signup),
--       admin-users.ts (admin), and Profile UI endpoints — none of which
--       currently set a vitana.actor_id session var. Enforcing today would
--       break legitimate flows.
--    3. The follow-up VTID will (a) wire all app_users writers through the
--       memory-identity-lock chokepoint that sets vitana.actor_id, then (b)
--       add the parallel trigger.
--
--    Tracking: see plan Part 8 Phase 0 file list — `app_users` trigger is in
--    the "deferred to follow-up" list.
-- ============================================================================


COMMIT;

-- =====================================================================
-- VERIFICATION (run after migration applies):
--
-- A) Trigger is bound:
--    SELECT tgname, tgenabled FROM pg_trigger
--      WHERE tgrelid = 'public.memory_facts'::regclass
--        AND tgname = 'trg_enforce_identity_lock_memory_facts';
--    -- Expected: 1 row, tgenabled='O' (origin/enabled).
--
-- B) Reject path (must FAIL with check_violation):
--    INSERT INTO memory_facts (tenant_id, user_id, entity, fact_key, fact_value, provenance_source, provenance_confidence)
--    VALUES (gen_random_uuid(), gen_random_uuid(), 'self', 'user_first_name', 'Kemal', 'assistant_inferred', 0.85);
--    -- Expected: ERROR identity_locked: fact_key=user_first_name ...
--
-- C) Allow path (must SUCCEED):
--    INSERT INTO memory_facts (tenant_id, user_id, entity, fact_key, fact_value, provenance_source, provenance_confidence)
--    VALUES (gen_random_uuid(), gen_random_uuid(), 'self', 'user_first_name', 'Maria', 'user_stated_via_settings', 1.0);
--    -- Expected: 1 row inserted.
--
-- D) Non-identity key (must SUCCEED with any provenance):
--    INSERT INTO memory_facts (tenant_id, user_id, entity, fact_key, fact_value, provenance_source, provenance_confidence)
--    VALUES (gen_random_uuid(), gen_random_uuid(), 'self', 'favorite_food', 'sushi', 'assistant_inferred', 0.7);
--    -- Expected: 1 row inserted.
-- =====================================================================
