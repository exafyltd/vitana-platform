-- VTID-04341: write_fact() no longer re-inserts a fact whose value did not change.
--
-- Live evidence (2026-09-23): memory_facts held 12,684 rows but only 918 were
-- current. 10,097 rows (80%) were `preferred_language`, rewritten with the SAME
-- value by orb-live's persistLanguagePreference() on every voice session, and
-- `user_name` had 446 assistant_inferred rewrites. Every rewrite superseded the
-- previous row, so the supersession history (the whole point of VTID-01192)
-- became noise and every downstream count (memory health, Garden progress,
-- mem_facts mirror) was inflated.
--
-- The previous body only skipped one narrow case (inferred write over a
-- user_stated fact with the same value). Several writers call this RPC
-- directly (inline-fact-extractor, intent-memory-hooks, diary-health-extractor,
-- memory-intelligence), so the fix belongs here, not in one TS caller.
--
-- New rule: if the current fact has the same value (trimmed, case-insensitive)
-- and the incoming write's provenance is not STRONGER than the current one,
-- return the existing id and write nothing. A stronger source confirming the
-- same value (e.g. assistant_inferred -> user_stated) still supersedes, so
-- provenance can only move up. A different value always supersedes, as before.
--
-- Provenance strength: user_* (user_stated, user_edited, …) = 3,
-- system_observed = 2, assistant_inferred = 1, anything else = 0.

CREATE OR REPLACE FUNCTION public._memory_provenance_rank(p_source text)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_source LIKE 'user\_%' THEN 3
    WHEN p_source = 'system_observed' THEN 2
    WHEN p_source = 'assistant_inferred' THEN 1
    ELSE 0
  END;
$$;

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
  v_new_fact_id := gen_random_uuid();

  SELECT id, provenance_source, fact_value
  INTO v_old_fact_id, v_old_provenance_source, v_old_fact_value
  FROM memory_facts
  WHERE tenant_id = p_tenant_id
    AND user_id = p_user_id
    AND fact_key = p_fact_key
    AND entity = p_entity
    AND superseded_by IS NULL
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  -- VTID-04341: same value, not a stronger source -> nothing changed.
  IF v_old_fact_id IS NOT NULL
     AND LOWER(TRIM(v_old_fact_value)) = LOWER(TRIM(p_fact_value))
     AND public._memory_provenance_rank(p_provenance_source)
         <= public._memory_provenance_rank(v_old_provenance_source) THEN
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

  IF v_old_fact_id IS NOT NULL THEN
    UPDATE memory_facts
    SET superseded_by = v_new_fact_id,
        superseded_at = now()
    WHERE id = v_old_fact_id;
  END IF;

  RETURN v_new_fact_id;
END;
$function$;
