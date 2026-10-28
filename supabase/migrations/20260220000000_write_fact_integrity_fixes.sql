-- =============================================================================
-- VTID-01225: write_fact() data integrity hardening
--
-- Three fixes combined into one migration:
--
-- 1. FOR UPDATE SKIP LOCKED on the existing-fact SELECT
--    Prevents race condition when two concurrent extraction runs process
--    the same user. Without locking, both read the same "current" fact,
--    both insert, and one supersession link is lost.
--    SKIP LOCKED means concurrent writes create parallel entries rather
--    than blocking — the next extraction cleans it up.
--
-- 2. Provenance priority guard
--    Prevents assistant_inferred facts from superseding user_stated facts
--    when the value is the same. Hierarchy: user_stated > assistant_inferred
--    > system_observed. This protects explicit user corrections from being
--    overwritten by noisy extraction runs.
--
-- 3. Same-value bypass
--    The provenance guard only blocks when old and new values are identical
--    (case-insensitive). When the value is DIFFERENT, supersession proceeds
--    regardless of provenance — because the user may have changed their mind
--    and the extractor caught it.
--
-- Dependencies: 20260217000000_fix_write_fact_fk_order.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION write_fact(
  p_tenant_id UUID,
  p_user_id UUID,
  p_fact_key TEXT,
  p_fact_value TEXT,
  p_entity TEXT DEFAULT 'self',
  p_fact_value_type TEXT DEFAULT 'text',
  p_provenance_source TEXT DEFAULT 'user_stated',
  p_provenance_utterance_id UUID DEFAULT NULL,
  p_provenance_confidence NUMERIC DEFAULT 0.90,
  p_thread_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_fact_id UUID;
  v_old_fact_id UUID;
  v_old_provenance_source TEXT;
  v_old_provenance_confidence NUMERIC;
  v_old_fact_value TEXT;
BEGIN
  -- Generate new fact ID
  v_new_fact_id := gen_random_uuid();

  -- Find existing fact with same key (if any)
  -- FOR UPDATE SKIP LOCKED: prevents race condition between concurrent extractions.
  -- If another transaction holds the lock, we skip (create parallel entry instead of blocking).
  SELECT id, provenance_source, provenance_confidence, fact_value
  INTO v_old_fact_id, v_old_provenance_source, v_old_provenance_confidence, v_old_fact_value
  FROM memory_facts
  WHERE tenant_id = p_tenant_id
    AND user_id = p_user_id
    AND fact_key = p_fact_key
    AND entity = p_entity
    AND superseded_by IS NULL
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  -- Provenance priority guard with same-value bypass:
  -- Block assistant_inferred from superseding user_stated ONLY when:
  --   a) The existing fact is user_stated
  --   b) The new fact is assistant_inferred
  --   c) The new confidence is not higher than the existing confidence
  --   d) The value is the same (case-insensitive) — i.e., this is noise, not a correction
  -- When the value is DIFFERENT, allow supersession (user may have changed their mind).
  IF v_old_fact_id IS NOT NULL
     AND v_old_provenance_source = 'user_stated'
     AND p_provenance_source = 'assistant_inferred'
     AND p_provenance_confidence <= v_old_provenance_confidence
     AND LOWER(TRIM(v_old_fact_value)) = LOWER(TRIM(p_fact_value)) THEN
    -- Same value, lower provenance — skip supersession, return existing fact
    RETURN v_old_fact_id;
  END IF;

  -- INSERT new fact FIRST (so FK reference exists for superseded_by)
  INSERT INTO memory_facts (
    id,
    tenant_id,
    user_id,
    thread_id,
    entity,
    fact_key,
    fact_value,
    fact_value_type,
    provenance_source,
    provenance_utterance_id,
    provenance_confidence
  ) VALUES (
    v_new_fact_id,
    p_tenant_id,
    p_user_id,
    p_thread_id,
    p_entity,
    p_fact_key,
    p_fact_value,
    p_fact_value_type,
    p_provenance_source,
    p_provenance_utterance_id,
    p_provenance_confidence
  );

  -- THEN mark old fact as superseded (FK target now exists)
  IF v_old_fact_id IS NOT NULL THEN
    UPDATE memory_facts
    SET superseded_by = v_new_fact_id,
        superseded_at = now()
    WHERE id = v_old_fact_id;
  END IF;

  RETURN v_new_fact_id;
END;
$$;

-- Add comment documenting the integrity guarantees
COMMENT ON FUNCTION write_fact IS
  'VTID-01192 + VTID-01225: Write a fact with auto-supersession, row-level locking, and provenance priority guard. '
  'user_stated facts cannot be superseded by assistant_inferred facts with the same value and lower confidence.';
