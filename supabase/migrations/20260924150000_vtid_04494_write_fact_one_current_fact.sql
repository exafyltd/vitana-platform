-- VTID-04494: one current fact per (tenant, user, entity, fact_key).
--
-- Live evidence (2026-09-24): 70 key groups across 26 users had more than one
-- current (superseded_by IS NULL) row in memory_facts; 19 of them held
-- conflicting values, so recall could hand the model two answers for the
-- same fact.
--
-- Two defects in write_fact():
--   1. `FOR UPDATE SKIP LOCKED`: a second concurrent writer skipped the row
--      the first had locked, saw "no current fact", and inserted another
--      current row. Two writers racing on a key with no current row had
--      nothing to lock at all. 38 duplicate pairs are < 0.5 s apart.
--   2. `LIMIT 1` + `WHERE id = v_old_fact_id`: a write superseded one current
--      row only, so once a duplicate existed it survived every later write
--      (the pairs minutes to months apart).
--
-- Fix: serialise writers per key with a transaction-scoped advisory lock
-- (it also covers the no-row case), compare against the newest current row,
-- and supersede every other current row. The VTID-04341 same-value skip is
-- unchanged, and it now also collapses stray duplicates onto the row it keeps.
--
-- Repair: every existing duplicate group keeps its newest row (the one the
-- next write_fact() would have compared against); the others are marked
-- superseded by it. Nothing is deleted, so the history stays.

CREATE OR REPLACE FUNCTION public.write_fact(
  p_tenant_id uuid,
  p_user_id uuid,
  p_fact_key text,
  p_fact_value text,
  p_entity text DEFAULT 'self'::text,
  p_fact_value_type text DEFAULT 'text'::text,
  p_provenance_source text DEFAULT 'user_stated'::text,
  p_provenance_utterance_id uuid DEFAULT NULL::uuid,
  p_provenance_confidence numeric DEFAULT 0.90,
  p_thread_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_new_fact_id UUID;
  v_old_fact_id UUID;
  v_old_provenance_source TEXT;
  v_old_fact_value TEXT;
BEGIN
  -- VTID-04494: one writer per key at a time, including when no row exists yet.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'memory_facts:' || p_tenant_id::text || ':' || p_user_id::text || ':'
        || coalesce(p_entity, '') || ':' || p_fact_key,
      0
    )
  );

  v_new_fact_id := gen_random_uuid();

  SELECT id, provenance_source, fact_value
  INTO v_old_fact_id, v_old_provenance_source, v_old_fact_value
  FROM memory_facts
  WHERE tenant_id = p_tenant_id
    AND user_id = p_user_id
    AND fact_key = p_fact_key
    AND entity = p_entity
    AND superseded_by IS NULL
  ORDER BY extracted_at DESC, id DESC
  LIMIT 1;

  -- VTID-04341: same value, not a stronger source -> nothing changed.
  IF v_old_fact_id IS NOT NULL
     AND LOWER(TRIM(v_old_fact_value)) = LOWER(TRIM(p_fact_value))
     AND public._memory_provenance_rank(p_provenance_source)
         <= public._memory_provenance_rank(v_old_provenance_source) THEN
    -- VTID-04494: fold any stray current duplicates onto the kept row.
    UPDATE memory_facts
    SET superseded_by = v_old_fact_id,
        superseded_at = now()
    WHERE tenant_id = p_tenant_id
      AND user_id = p_user_id
      AND fact_key = p_fact_key
      AND entity = p_entity
      AND superseded_by IS NULL
      AND id <> v_old_fact_id;
    RETURN v_old_fact_id;
  END IF;

  INSERT INTO memory_facts (
    id, tenant_id, user_id, thread_id, entity,
    fact_key, fact_value, fact_value_type,
    provenance_source, provenance_utterance_id, provenance_confidence
  ) VALUES (
    v_new_fact_id, p_tenant_id, p_user_id, p_thread_id, p_entity,
    p_fact_key, p_fact_value, p_fact_value_type,
    p_provenance_source, p_provenance_utterance_id, p_provenance_confidence
  );

  -- VTID-04494: supersede every other current row, not just one.
  UPDATE memory_facts
  SET superseded_by = v_new_fact_id,
      superseded_at = now()
  WHERE tenant_id = p_tenant_id
    AND user_id = p_user_id
    AND fact_key = p_fact_key
    AND entity = p_entity
    AND superseded_by IS NULL
    AND id <> v_new_fact_id;

  RETURN v_new_fact_id;
END;
$function$;

-- Repair existing duplicates: newest row per key stays current.
WITH ranked AS (
  SELECT id,
         first_value(id) OVER w AS keeper,
         row_number() OVER w AS rn
  FROM memory_facts
  WHERE superseded_by IS NULL
  WINDOW w AS (
    PARTITION BY tenant_id, user_id, entity, fact_key
    ORDER BY extracted_at DESC, id DESC
  )
)
UPDATE memory_facts m
SET superseded_by = r.keeper,
    superseded_at = now()
FROM ranked r
WHERE m.id = r.id
  AND r.rn > 1;
