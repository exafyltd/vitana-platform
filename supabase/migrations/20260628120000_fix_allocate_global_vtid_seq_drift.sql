-- =============================================================================
-- Fix: allocate_global_vtid 409s with duplicate-key when global_vtid_seq has
--      drifted behind manually-inserted / out-of-band high-numbered VTIDs.
--
-- Symptom (Command Hub → PUBLISH button, and any /api/v1/vtid/allocate caller):
--   Clicking PUBLISH returns
--     `{"code":"23505","details":"Key (vtid)=(VTID-03346) already exists.",
--       "message":"duplicate key value violates unique constraint
--       \"vtid_ledger_vtid_unique\""}`
--   Retrying the click usually succeeds, because nextval() is NOT rolled back
--   on the failed INSERT — the sequence steps forward by one each attempt and
--   eventually walks past the occupied range.
--
-- Root cause:
--   global_vtid_seq is only ONE of several writers into the VTID-XXXXX number
--   space, but the others never advance it, so the sequence drifts BEHIND the
--   real MAX(vtid) in vtid_ledger:
--     - self-healing reconciler: createFreshVtidFromTriageReport() mints
--       `latest vtid + 1` and direct-inserts (ignores the sequence)
--     - VAEA migrations (VTID-024xx) inserted high-numbered rows directly
--     - earlier migration did setval('global_vtid_seq', 1984)
--   When nextval() climbs back into a range already occupied by those rows,
--   the INSERT inside allocate_global_vtid() collides on
--   vtid_ledger_vtid_unique.
--
-- This is the SAME class of bug already fixed for the recommendation allocator
-- in 20260428000000_activate_recommendation_in_progress.sql. That fix was never
-- applied to allocate_global_vtid (the function PUBLISH / the generic allocate
-- route use). This migration applies the same two-part fix here:
--   1. Rewrite allocate_global_vtid() to use a bounded skip-forward loop:
--      keep pulling nextval() until the candidate VTID is free, so a
--      pre-existing row can never break allocation. (structural prevention)
--   2. One-shot reseed of global_vtid_seq above MAX(vtid number) + buffer so
--      the next nextval() can't collide. (immediate relief)
--
-- The companion application-side fix (making createFreshVtidFromTriageReport
-- allocate via this RPC instead of MAX+1) removes the writer that CREATES the
-- drift; see services/gateway/src/services/self-healing-triage-service.ts.
-- =============================================================================

-- Defensive: make sure the sequence the function depends on exists.
DO $$
BEGIN
    CREATE SEQUENCE global_vtid_seq START WITH 1000 INCREMENT BY 1;
EXCEPTION WHEN duplicate_table THEN
    NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Hardened allocator: bounded skip-forward loop around nextval()
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS allocate_global_vtid(text, text, text);

CREATE OR REPLACE FUNCTION allocate_global_vtid(
    p_source TEXT DEFAULT 'api',
    p_layer TEXT DEFAULT 'DEV',
    p_module TEXT DEFAULT 'TASK'
)
RETURNS TABLE(vtid TEXT, num BIGINT, id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
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
        ),
        NOW(),
        NOW()
    );

    -- Return the allocated VTID info
    RETURN QUERY SELECT v_vtid, v_num, v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION allocate_global_vtid(TEXT, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION allocate_global_vtid IS
    'VTID-0542: Atomically allocates next FREE VTID and creates a shell entry in vtid_ledger. Uses a bounded skip-forward loop so it tolerates sequence drift caused by out-of-band VTID writers.';

-- ---------------------------------------------------------------------------
-- 2. One-shot reseed: push the sequence past the current MAX(vtid number)
--    so the very next allocation can't collide even before the loop kicks in.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_max BIGINT;
  v_seq_last BIGINT;
  v_target BIGINT;
BEGIN
  SELECT COALESCE(MAX((REGEXP_MATCH(vtid, '^VTID-(\d+)$'))[1]::BIGINT), 0)
    INTO v_max
    FROM vtid_ledger
   WHERE vtid ~ '^VTID-\d+$';

  -- Read last_value from the sequence relation (currval() throws when no
  -- nextval() has been called yet in this session).
  SELECT last_value INTO v_seq_last FROM global_vtid_seq;

  -- 100-row buffer absorbs any VTIDs minted between this migration running
  -- and the first post-migration nextval().
  v_target := GREATEST(v_max + 100, v_seq_last);
  PERFORM setval('global_vtid_seq', v_target);

  RAISE NOTICE 'global_vtid_seq reseeded to % (max ledger VTID number was %, prior seq last_value was %)',
    v_target, v_max, v_seq_last;
END $$;
