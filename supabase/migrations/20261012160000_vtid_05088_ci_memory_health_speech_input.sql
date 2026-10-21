-- VTID-05088 — ci_memory_health(): add the input side (did anyone speak?).
--
-- MORNING-SYSTEM-HEALTH-CHECK.yml row 21 failed on 2026-10-11 with
-- "no-memory-writes-24h" while the memory pipeline was healthy: nobody had a
-- voice conversation in that window (last one 2026-10-08, which wrote 15
-- items). Writes alone cannot tell a quiet day from a broken writer, so the
-- function now also reports how many user turns were spoken and how many
-- reached the writer. Every existing key, SECURITY DEFINER, search_path and
-- the service_role-only grant are unchanged from
-- 20260923140000_vtid_04345_ci_memory_health.sql.
--
-- Idempotent: CREATE OR REPLACE with the same signature.
--
-- impact-allow-solo-migration
--   The only caller is .github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml,
--   changed in the same PR.

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
    -- VTID-05088: input side. Without it a quiet day (nobody spoke) and a
    -- broken pipeline both read as writes=0. User turns whose transcribed
    -- text, summed over the turn's fragments, exceeds 20 chars — the same
    -- whole-buffer gate the writer uses (upstream-message-handler.ts
    -- `userText.length > 20`). Emitted upstream of the writer, so it stays
    -- positive if the path to the writer breaks. Two accepted
    -- approximations, both on the safe side: inter-fragment spaces are not
    -- counted (a borderline turn may be missed), and Vertex (sr/ru)
    -- fragments may be cumulative, which overcounts (such a turn always
    -- reads as speech).
    'user_speech_turns_24h',
      (SELECT count(*) FROM (
        SELECT 1 FROM oasis_events
         WHERE topic = 'orb.live.diag'
           AND metadata->>'stage' = 'input_transcription'
           AND created_at > now() - interval '24 hours'
         GROUP BY metadata->>'session_id', metadata->>'turn_count'
        HAVING sum(char_length(coalesce(metadata->>'text_preview', ''))) > 20) t),
    -- Turns that reached the writer (recorded before its trivial-message
    -- filter, orb-memory-bridge.ts recordTranscriptTurn).
    'transcript_turns_24h',
      (SELECT count(*) FROM memory_transcript_turns WHERE created_at > now() - interval '24 hours'),
    'checked_at', now()
  );
$$;

REVOKE ALL ON FUNCTION public.ci_memory_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ci_memory_health() TO service_role;

COMMENT ON FUNCTION public.ci_memory_health() IS
  'VTID-04345 / VTID-05088: daily memory-system health numbers for MORNING-SYSTEM-HEALTH-CHECK.yml (writes, user speech and transcript turns, embedding coverage, DLQ, prompt injection, AP-0910 recency). Counts only, service_role only.';
