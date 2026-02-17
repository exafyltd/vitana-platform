-- =============================================================================
-- VTID-01225: Fix write_fact() FK constraint violation on supersession
--
-- Problem: write_fact() updates old fact's superseded_by to point to new fact ID
-- BEFORE inserting the new fact. The FK constraint on superseded_by rejects this
-- because the referenced row doesn't exist yet.
--
-- Fix: INSERT the new fact first, THEN UPDATE the old fact's superseded_by.
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
BEGIN
  -- Generate new fact ID
  v_new_fact_id := gen_random_uuid();

  -- Find existing fact with same key (if any)
  SELECT id INTO v_old_fact_id
  FROM memory_facts
  WHERE tenant_id = p_tenant_id
    AND user_id = p_user_id
    AND fact_key = p_fact_key
    AND entity = p_entity
    AND superseded_by IS NULL
  LIMIT 1;

  -- INSERT new fact FIRST (so FK reference exists)
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
