-- VTID-04345 — ci_memory_health(): one daily answer to "is memory working?"
-- (docs/MEMORY-SYSTEM-PLAN.md §5, reliability item 2).
--
-- WHY THIS EXISTS
--
-- The memory system failed silently for months, in ways no existing check
-- could see:
--   * embeddings stopped 2026-04-28 (OpenAI/Gemini keys absent on AWS);
--     semantic recall degraded to "most recent" with no error anywhere;
--   * the memory-intelligence automations (AP-0906..AP-0913, incl. the
--     AP-0910 embedding backfill) last ran 2026-07 — their scheduler died
--     with GCP;
--   * 80% of memory_facts rows were `preferred_language` rewritten with the
--     same value on every session (fixed by VTID-04341);
--   * the diary never reached the prompt (diary_loaded=0 on every turn,
--     fixed by VTID-04343).
-- This RPC reports the numbers that expose each of those, over PostgREST,
-- so MORNING-SYSTEM-HEALTH-CHECK.yml can judge them daily.
--
-- SECURITY: SECURITY DEFINER, service_role only — same as its siblings.
-- Returns counts and timestamps only, never memory content.
--
-- impact-allow-solo-migration
--   The only caller is .github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml,
--   shipped in the same PR, which calls the RPC directly over PostgREST.

CREATE OR REPLACE FUNCTION public.ci_memory_health()
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
STABLE
AS $$
  SELECT json_build_object(
    -- Writes: is anything being remembered at all?
    'facts_written_24h',
      (SELECT count(*) FROM memory_facts WHERE extracted_at > now() - interval '24 hours'),
    'items_written_24h',
      (SELECT count(*) FROM memory_items WHERE created_at > now() - interval '24 hours'),
    -- Churn: same-value rewrites of one key (VTID-04341 regression guard).
    'preferred_language_writes_24h',
      (SELECT count(*) FROM memory_facts
        WHERE fact_key = 'preferred_language' AND extracted_at > now() - interval '24 hours'),
    -- Embedding coverage, judged only on rows older than 2h so a fresh write
    -- still waiting for its async embed / the next AP-0910 run is not a miss.
    'facts_active_2h',
      (SELECT count(*) FROM memory_facts
        WHERE superseded_by IS NULL AND extracted_at < now() - interval '2 hours'),
    'facts_active_embedded_2h',
      (SELECT count(*) FROM memory_facts
        WHERE superseded_by IS NULL AND embedding IS NOT NULL AND extracted_at < now() - interval '2 hours'),
    'items_2h',
      (SELECT count(*) FROM memory_items
        WHERE created_at < now() - interval '2 hours' AND coalesce(trim(content), '') <> ''),
    'items_embedded_2h',
      (SELECT count(*) FROM memory_items
        WHERE embedding IS NOT NULL AND created_at < now() - interval '2 hours'),
    'last_embedding_at',
      (SELECT max(t) FROM (
        SELECT max(embedding_updated_at) AS t FROM memory_items
        UNION ALL SELECT max(embedding_updated_at) FROM memory_facts) x),
    -- Failed writes nobody replayed.
    'dlq_new_24h',
      (SELECT count(*) FROM memory_write_dlq WHERE created_at > now() - interval '24 hours'),
    -- Reads: is memory actually reaching the prompt?
    'context_built_24h',
      (SELECT count(*) FROM oasis_events
        WHERE topic = 'memory.orchestrator.context_built' AND created_at > now() - interval '24 hours'),
    'context_with_memory_24h',
      (SELECT count(*) FROM oasis_events
        WHERE topic = 'memory.orchestrator.context_built' AND created_at > now() - interval '24 hours'
          AND coalesce((metadata->>'memory_hits')::int, 0) > 0),
    'context_with_diary_24h',
      (SELECT count(*) FROM oasis_events
        WHERE topic = 'memory.orchestrator.context_built' AND created_at > now() - interval '24 hours'
          AND coalesce((metadata->>'diary_loaded')::int, 0) > 0),
    -- The embedding backfill actually runs (its scheduler died once already).
    'ap0910_last_run',
      (SELECT max(started_at) FROM automation_runs WHERE automation_id = 'AP-0910'),
    'checked_at', now()
  );
$$;

REVOKE ALL ON FUNCTION public.ci_memory_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ci_memory_health() TO service_role;

COMMENT ON FUNCTION public.ci_memory_health() IS
  'VTID-04345: daily memory-system health numbers for MORNING-SYSTEM-HEALTH-CHECK.yml (writes, embedding coverage, DLQ, prompt injection, AP-0910 recency). Counts only, service_role only.';
