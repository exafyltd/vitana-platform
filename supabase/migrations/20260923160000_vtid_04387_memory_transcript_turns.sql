-- VTID-04387: raw conversation turns get their own table with a 90-day TTL.
--
-- Until now every raw user utterance was written to memory_items (2,666 of
-- 3,183 rows on 2026-09-23 were raw turns), which drowned the episodes that
-- recall should find. The owner decided (2026-09-23): raw turns are kept 90
-- days, then deleted; summaries and facts are kept.
--
-- Writers: the gateway only (service role), from writeMemoryItemWithIdentity()
-- for any row whose content_json.direction is 'user' or 'assistant'.
-- Readers: the gateway (recent-turn grounding, session transcript rebuild) and
-- the user themself (RLS: own rows only).

CREATE TABLE IF NOT EXISTS public.memory_transcript_turns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  user_id          uuid NOT NULL,
  session_id       text,
  conversation_id  text,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text NOT NULL,
  source           text NOT NULL,
  channel          text,
  active_role      text,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_transcript_turns_user_time
  ON public.memory_transcript_turns (tenant_id, user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_transcript_turns_session
  ON public.memory_transcript_turns (session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_transcript_turns_created
  ON public.memory_transcript_turns (created_at);

ALTER TABLE public.memory_transcript_turns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_transcript_turns_select_own ON public.memory_transcript_turns;
CREATE POLICY memory_transcript_turns_select_own
  ON public.memory_transcript_turns
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.memory_transcript_turns FROM anon;
GRANT SELECT ON public.memory_transcript_turns TO authenticated;
GRANT ALL ON public.memory_transcript_turns TO service_role;

COMMENT ON TABLE public.memory_transcript_turns IS
  'VTID-04387: raw conversation turns, kept 90 days (purge_memory_transcript_turns). Summaries and facts live in memory_items / memory_facts.';

-- Purge: deletes turns older than p_days (default 90), in batches so a large
-- backlog never holds a long lock. Returns the number of rows deleted.
CREATE OR REPLACE FUNCTION public.purge_memory_transcript_turns(p_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total integer := 0;
  v_batch integer;
BEGIN
  IF p_days IS NULL OR p_days < 30 THEN
    RAISE EXCEPTION 'purge_memory_transcript_turns: p_days must be >= 30 (got %)', p_days;
  END IF;
  LOOP
    DELETE FROM public.memory_transcript_turns
    WHERE id IN (
      SELECT id FROM public.memory_transcript_turns
      WHERE created_at < now() - make_interval(days => p_days)
      LIMIT 5000
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    EXIT WHEN v_batch = 0;
  END LOOP;
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_memory_transcript_turns(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_memory_transcript_turns(integer) TO service_role;

-- Daily at 03:17 UTC. pg_cron is installed on this project.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-memory-transcript-turns';
    PERFORM cron.schedule(
      'purge-memory-transcript-turns',
      '17 3 * * *',
      'SELECT public.purge_memory_transcript_turns(90);'
    );
  END IF;
END;
$$;
