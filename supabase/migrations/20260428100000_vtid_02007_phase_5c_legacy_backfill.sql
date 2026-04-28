-- VTID-02007 / Phase 5c — legacy backfill of memory_items / memory_facts /
-- relationship_edges into the new bi-temporal mem_* tables introduced
-- in Phase 5a (VTID-02003).
--
-- After this migration, Tier 2 reads can serve the FULL historical
-- corpus, not just rows written after the dual-writer flipped on
-- (Phase 5b / VTID-02005).
--
-- Sizes at write time:
--   memory_items:       2867 rows  →  mem_episodes
--   memory_facts:       4797 rows  →  mem_facts
--   relationship_edges:    3 rows  →  mem_graph_edges
--
-- All idempotent: re-running this migration is a no-op because the
-- backfill INSERTs use NOT EXISTS / source_event_id de-duplication.

BEGIN;

-- ============================================================================
-- 0. mem_graph_edges.user_id → make nullable (relationship_edges has no
--    direct user_id; we derive from source_id when source_type='person'
--    or 'user', else NULL).
-- ============================================================================

ALTER TABLE public.mem_graph_edges
  ALTER COLUMN user_id DROP NOT NULL;

-- ============================================================================
-- 1. memory_items → mem_episodes (preserve embeddings)
-- ============================================================================

DO $backfill_episodes$
DECLARE
  v_inserted bigint;
BEGIN
  WITH inserted AS (
    INSERT INTO public.mem_episodes (
      tenant_id, user_id,
      conversation_id,
      kind, content, content_json, importance,
      category_key, source, workspace_scope, active_role,
      visibility_scope, origin_service, vtid,
      embedding, embedding_model, embedding_updated_at,
      occurred_at, valid_from, asserted_at,
      actor_id, confidence, source_event_id,
      policy_version, source_engine, classification
    )
    SELECT
      mi.tenant_id, mi.user_id,
      mi.conversation_id,
      'utterance'::text AS kind,
      mi.content,
      mi.content_json,
      LEAST(GREATEST(COALESCE(mi.importance, 30), 0), 100) AS importance,
      mi.category_key, mi.source, mi.workspace_scope, mi.active_role,
      COALESCE(mi.visibility_scope, 'private') AS visibility_scope,
      mi.origin_service, mi.vtid,
      mi.embedding, mi.embedding_model, mi.embedding_updated_at,
      mi.occurred_at,
      COALESCE(mi.occurred_at, mi.created_at) AS valid_from,
      COALESCE(mi.created_at, now()) AS asserted_at,
      CASE
        WHEN (mi.content_json->>'direction') = 'assistant' THEN 'assistant'
        ELSE 'user'
      END AS actor_id,
      COALESCE(mi.provenance_confidence, 1.0) AS confidence,
      mi.id::text AS source_event_id,
      'mem-2026.04' AS policy_version,
      COALESCE(mi.source_engine, mi.source, 'legacy_backfill_phase_5c') AS source_engine,
      '{}'::jsonb AS classification
    FROM public.memory_items mi
    WHERE NOT EXISTS (
      SELECT 1 FROM public.mem_episodes me
      WHERE me.source_event_id = mi.id::text
    )
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM inserted;
  RAISE NOTICE 'STEP 1 — backfilled % rows from memory_items into mem_episodes', v_inserted;
END
$backfill_episodes$;

-- ============================================================================
-- 2. memory_facts → mem_facts
--    Bi-temporal mapping:
--      mf.superseded_at  →  mft.valid_to
--      mf.extracted_at   →  mft.valid_from / asserted_at
--    The partial unique index on mem_facts (tenant, user, entity, fact_key)
--    WHERE valid_to IS NULL is preserved because at most one row per
--    (tenant, user, entity, fact_key) has superseded_at NULL in memory_facts.
-- ============================================================================

-- Note: memory_facts.embedding is vector(768) but mem_facts.embedding is
-- vector(1536). Different dimensions = pgvector rejects an INSERT...SELECT
-- mapping. Drop the embedding columns from this backfill — the dual-writer
-- (Phase 5b) populates them correctly with 1536-dim vectors on new writes,
-- and a future re-embed pass can fill the historical NULLs.
DO $backfill_facts$
DECLARE
  v_inserted bigint;
BEGIN
  WITH ranked AS (
    -- Order rows per (tenant, user, entity, fact_key) by extracted_at DESC.
    -- The most recent row (rn=1) is the canonical active fact in mem_facts.
    -- Older "active" rows in memory_facts (where someone forgot to set
    -- superseded_at) get a synthetic valid_to so the partial unique index
    -- WHERE valid_to IS NULL is never violated.
    SELECT
      mf.*,
      ROW_NUMBER() OVER (
        PARTITION BY mf.tenant_id, mf.user_id, COALESCE(mf.entity, 'self'), mf.fact_key
        ORDER BY mf.extracted_at DESC, mf.id DESC
      ) AS rn
    FROM public.memory_facts mf
  ),
  inserted AS (
    INSERT INTO public.mem_facts (
      tenant_id, user_id, entity, fact_key, fact_value, fact_value_type,
      valid_from, valid_to, asserted_at,
      actor_id, confidence, source_event_id,
      policy_version, source_engine, classification,
      extracted_at, vtid
    )
    SELECT
      r.tenant_id, r.user_id,
      COALESCE(r.entity, 'self') AS entity,
      r.fact_key, r.fact_value,
      COALESCE(r.fact_value_type, 'text') AS fact_value_type,
      r.extracted_at AS valid_from,
      -- valid_to:
      --   rn=1 active (no superseded_at) → NULL (the canonical active row)
      --   else → use source superseded_at, or fall back to extracted_at+1s
      --   so the partial unique index is satisfied.
      CASE
        WHEN r.rn = 1 AND r.superseded_at IS NULL THEN NULL
        ELSE COALESCE(r.superseded_at, r.extracted_at + interval '1 second')
      END AS valid_to,
      r.extracted_at AS asserted_at,
      COALESCE(r.provenance_source, 'user_stated') AS actor_id,
      COALESCE(r.provenance_confidence, 1.0) AS confidence,
      r.id::text AS source_event_id,
      'mem-2026.04' AS policy_version,
      'legacy_backfill_phase_5c' AS source_engine,
      '{}'::jsonb AS classification,
      r.extracted_at, r.vtid
    FROM ranked r
    WHERE NOT EXISTS (
      SELECT 1 FROM public.mem_facts mft
      WHERE mft.source_event_id = r.id::text
    )
    -- Skip rows that would conflict with an already-mirrored ACTIVE fact
    -- (e.g. a row written by the Phase 5b dual-writer after the flag flipped).
    AND NOT (
      r.rn = 1 AND r.superseded_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.mem_facts mft
        WHERE mft.tenant_id = r.tenant_id
          AND mft.user_id   = r.user_id
          AND mft.entity    = COALESCE(r.entity, 'self')
          AND mft.fact_key  = r.fact_key
          AND mft.valid_to IS NULL
      )
    )
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM inserted;
  RAISE NOTICE 'STEP 2 — backfilled % rows from memory_facts into mem_facts', v_inserted;
END
$backfill_facts$;

-- ============================================================================
-- 3. relationship_edges → mem_graph_edges
-- ============================================================================

DO $backfill_edges$
DECLARE
  v_inserted bigint;
BEGIN
  WITH inserted AS (
    INSERT INTO public.mem_graph_edges (
      tenant_id, user_id,
      source_type, source_id, target_type, target_id,
      edge_type, strength, metadata,
      last_interaction_at, valid_from, asserted_at,
      actor_id, confidence, source_event_id,
      policy_version, source_engine
    )
    SELECT
      re.tenant_id,
      -- Derive user_id where source/target is a person or user; else NULL
      CASE
        WHEN re.source_type IN ('user','person') THEN re.source_id
        WHEN re.target_type IN ('user','person') THEN re.target_id
        ELSE NULL
      END AS user_id,
      re.source_type, re.source_id, re.target_type, re.target_id,
      re.edge_type,
      COALESCE(re.strength, 0.5) AS strength,
      COALESCE(re.metadata, '{}'::jsonb) AS metadata,
      re.last_interaction_at,
      COALESCE(re.created_at, now()) AS valid_from,
      COALESCE(re.created_at, now()) AS asserted_at,
      'legacy_backfill' AS actor_id,
      1.0 AS confidence,
      re.id::text AS source_event_id,
      'mem-2026.04' AS policy_version,
      'legacy_backfill_phase_5c' AS source_engine
    FROM public.relationship_edges re
    WHERE NOT EXISTS (
      SELECT 1 FROM public.mem_graph_edges mge
      WHERE mge.source_event_id = re.id::text
    )
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM inserted;
  RAISE NOTICE 'STEP 3 — backfilled % rows from relationship_edges into mem_graph_edges', v_inserted;
END
$backfill_edges$;

-- ============================================================================
-- 4. Trigger on relationship_edges → auto-mirror future INSERTs to
--    mem_graph_edges. This replaces the per-call-site dual-writer wiring
--    that was deferred from Phase 5b (5+ writer files would need touching).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.mirror_relationship_edge_to_tier2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $trg$
DECLARE
  v_user_id uuid;
BEGIN
  -- Skip if the gate flag is off
  IF NOT EXISTS (
    SELECT 1 FROM public.system_controls
    WHERE key = 'mem_tier2_dual_write_enabled' AND enabled = true
  ) THEN
    RETURN NEW;
  END IF;

  -- Derive user_id where possible (matches the backfill logic above)
  v_user_id := CASE
    WHEN NEW.source_type IN ('user','person') THEN NEW.source_id
    WHEN NEW.target_type IN ('user','person') THEN NEW.target_id
    ELSE NULL
  END;

  BEGIN
    INSERT INTO public.mem_graph_edges (
      tenant_id, user_id,
      source_type, source_id, target_type, target_id,
      edge_type, strength, metadata,
      last_interaction_at, valid_from, asserted_at,
      actor_id, confidence, source_event_id,
      policy_version, source_engine
    ) VALUES (
      NEW.tenant_id, v_user_id,
      NEW.source_type, NEW.source_id, NEW.target_type, NEW.target_id,
      NEW.edge_type,
      COALESCE(NEW.strength, 0.5),
      COALESCE(NEW.metadata, '{}'::jsonb),
      NEW.last_interaction_at,
      COALESCE(NEW.created_at, now()),
      COALESCE(NEW.created_at, now()),
      'trigger:relationship_edges_mirror',
      1.0,
      NEW.id::text,
      'mem-2026.04',
      'relationship_edges_mirror'
    );
  EXCEPTION WHEN OTHERS THEN
    -- Trigger MUST NOT break the primary write. Park the failure in the
    -- DLQ and continue.
    INSERT INTO public.memory_write_dlq (
      tenant_id, user_id, stream, payload, provenance,
      error_class, error_message, attempt_count, next_retry_at
    ) VALUES (
      NEW.tenant_id, v_user_id, 'mem_graph_edges',
      to_jsonb(NEW),
      jsonb_build_object('actor_id', 'trigger:relationship_edges_mirror', 'policy_version', 'mem-2026.04'),
      SQLSTATE,
      LEFT(SQLERRM, 1000),
      0,
      now() + interval '60 seconds'
    );
  END;

  RETURN NEW;
END
$trg$;

DROP TRIGGER IF EXISTS mirror_relationship_edge_to_tier2_trg ON public.relationship_edges;
CREATE TRIGGER mirror_relationship_edge_to_tier2_trg
  AFTER INSERT ON public.relationship_edges
  FOR EACH ROW
  EXECUTE FUNCTION public.mirror_relationship_edge_to_tier2();

COMMENT ON FUNCTION public.mirror_relationship_edge_to_tier2 IS
  'VTID-02007 Phase 5c — auto-mirror relationship_edges INSERTs into mem_graph_edges. Gated by system_controls.mem_tier2_dual_write_enabled. Fire-and-forget — failures land in memory_write_dlq.';

-- ============================================================================
-- 5. Final reconciliation report
-- ============================================================================

SELECT 'mem_episodes count'    AS report, COUNT(*) AS total FROM public.mem_episodes
UNION ALL
SELECT 'mem_facts count'                , COUNT(*)         FROM public.mem_facts
UNION ALL
SELECT 'mem_graph_edges count'          , COUNT(*)         FROM public.mem_graph_edges
UNION ALL
SELECT 'memory_write_dlq unresolved'    , COUNT(*)         FROM public.memory_write_dlq WHERE resolved_at IS NULL;

COMMIT;
