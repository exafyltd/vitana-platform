-- VTID-04371 — Conversation rebuild WS-0.7: hourly conversation metrics.
--
-- Command Hub → Conversation → Monitor and Assistant → Metrics read these
-- rows instead of scanning oasis_events on every page load. oasis_events has
-- no plain created_at index (VTID-03980), so every read below filters by
-- topic first and uses idx_oasis_events_topic_created_desc for a one-hour
-- range scan.
--
-- Long format: one row per (hour, metric, dimension). dimension is '' for the
-- total and '<kind>:<value>' for a breakdown (lang:de, opener:conv_resume,
-- kind:content_filter, ...). value is a count, a sum, an average or a
-- percentile depending on the metric; sample_count is the number of rows the
-- value was computed from, so a rate is value / sample_count where noted.
--
-- The rollup is idempotent per hour (delete + insert inside one function
-- call). pg_cron re-rolls the previous two hours at :07 so late events land.

CREATE TABLE IF NOT EXISTS public.conversation_metrics_hourly (
  hour_start    TIMESTAMPTZ      NOT NULL,
  metric        TEXT             NOT NULL,
  dimension     TEXT             NOT NULL DEFAULT '',
  value         DOUBLE PRECISION NOT NULL,
  sample_count  INTEGER          NOT NULL DEFAULT 0,
  computed_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hour_start, metric, dimension)
);

CREATE INDEX IF NOT EXISTS idx_conversation_metrics_hourly_metric_hour
  ON public.conversation_metrics_hourly (metric, hour_start DESC);

ALTER TABLE public.conversation_metrics_hourly ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_metrics_hourly_service ON public.conversation_metrics_hourly;
CREATE POLICY conversation_metrics_hourly_service ON public.conversation_metrics_hourly
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

REVOKE ALL ON public.conversation_metrics_hourly FROM anon, authenticated;

COMMENT ON TABLE public.conversation_metrics_hourly IS
  'VTID-04371: hourly conversation metrics rolled up from oasis_events (topic-filtered) and memory_facts. Written only by conversation_metrics_rollup_hour(); read by the gateway admin metrics endpoints.';

-- ---------------------------------------------------------------------------
-- conversation_metrics_rollup_hour(p_hour) — recompute one hour.
-- Returns the number of rows written for that hour.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.conversation_metrics_rollup_hour(p_hour TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h0 TIMESTAMPTZ := date_trunc('hour', p_hour);
  h1 TIMESTAMPTZ := date_trunc('hour', p_hour) + INTERVAL '1 hour';
  n  INTEGER;
BEGIN
  DELETE FROM conversation_metrics_hourly WHERE hour_start = h0;

  -- Sessions started, total and per language.
  INSERT INTO conversation_metrics_hourly (hour_start, metric, dimension, value, sample_count)
  SELECT h0, 'sessions_started', d, COUNT(*), COUNT(*)
  FROM (
    SELECT metadata->>'session_id' AS sid, metadata->>'lang' AS lang
    FROM oasis_events
    WHERE topic = 'vtid.live.session.start' AND created_at >= h0 AND created_at < h1
  ) s
  CROSS JOIN LATERAL (VALUES (''), ('lang:' || COALESCE(NULLIF(s.lang, ''), 'unknown'))) AS v(d)
  GROUP BY d;

  -- Session stops, one row per session (stop events can repeat).
  WITH stops AS (
    SELECT metadata->>'session_id' AS sid,
           COUNT(*) AS events,
           MAX(NULLIF(metadata->>'user_turns', '')::numeric)       AS user_turns,
           MAX(NULLIF(metadata->>'duration_ms', '')::numeric)      AS duration_ms,
           MAX(NULLIF(metadata->>'audio_out_chunks', '')::numeric) AS audio_out
    FROM oasis_events
    WHERE topic = 'vtid.live.session.stop' AND created_at >= h0 AND created_at < h1
    GROUP BY 1
  )
  INSERT INTO conversation_metrics_hourly (hour_start, metric, dimension, value, sample_count)
  SELECT h0, m.metric, '', m.value, m.samples
  FROM (
    SELECT 'sessions_stopped' AS metric, COUNT(*)::float8 AS value, COUNT(*)::int AS samples FROM stops
    UNION ALL
    SELECT 'session_stop_duplicates', COALESCE(SUM(events - 1), 0), COUNT(*) FROM stops
    UNION ALL
    SELECT 'silent_sessions', COUNT(*) FILTER (WHERE audio_out = 0), COUNT(*) FILTER (WHERE audio_out IS NOT NULL) FROM stops
    UNION ALL
    SELECT 'user_turns_avg', AVG(user_turns), COUNT(user_turns) FROM stops
    UNION ALL
    SELECT 'session_duration_ms_p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms), COUNT(duration_ms) FROM stops
    UNION ALL
    SELECT 'session_duration_ms_p90', percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms), COUNT(duration_ms) FROM stops
  ) m
  WHERE m.samples > 0 AND m.value IS NOT NULL;

  -- First model audio and context-wait timeouts from the turn-0 latency marks.
  WITH lat AS (
    SELECT e.metadata->>'transport' AS transport,
           (SELECT MIN((p->>'offset_ms')::numeric)
              FROM jsonb_array_elements(COALESCE(e.metadata->'phases', '[]'::jsonb)) p
             WHERE p->>'phase' = 'audio_out_first_chunk') AS first_audio_ms,
           (SELECT COUNT(*)
              FROM jsonb_array_elements(COALESCE(e.metadata->'phases', '[]'::jsonb)) p
             WHERE p->>'phase' = 'context_awaited') AS ctx_waits,
           (SELECT COUNT(*)
              FROM jsonb_array_elements(COALESCE(e.metadata->'phases', '[]'::jsonb)) p
             WHERE p->>'phase' = 'context_awaited'
               AND (p->'detail'->>'timed_out') = 'true') AS ctx_timeouts
    FROM oasis_events e
    WHERE e.topic = 'voice.latency.measured' AND e.created_at >= h0 AND e.created_at < h1
      AND COALESCE(e.metadata->>'turn', '0') = '0'
  ),
  dims AS (
    SELECT l.*, v.d
    FROM lat l
    CROSS JOIN LATERAL (VALUES (''), ('transport:' || COALESCE(NULLIF(l.transport, ''), 'unknown'))) AS v(d)
  )
  INSERT INTO conversation_metrics_hourly (hour_start, metric, dimension, value, sample_count)
  SELECT h0, m.metric, m.d, m.value, m.samples
  FROM (
    SELECT d, 'first_audio_ms_p50' AS metric,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY first_audio_ms) AS value,
           COUNT(first_audio_ms)::int AS samples
      FROM dims GROUP BY d
    UNION ALL
    SELECT d, 'first_audio_ms_p90', percentile_cont(0.9) WITHIN GROUP (ORDER BY first_audio_ms), COUNT(first_audio_ms)
      FROM dims GROUP BY d
    UNION ALL
    SELECT d, 'context_wait_timeouts', SUM(ctx_timeouts), SUM(ctx_waits)::int
      FROM dims GROUP BY d
  ) m
  WHERE m.samples > 0 AND m.value IS NOT NULL;

  -- Live-session diagnostics: counters per stage, openers, upstream errors.
  WITH diag AS (
    SELECT metadata->>'stage' AS stage, metadata AS m
    FROM oasis_events
    WHERE topic = 'orb.live.diag' AND created_at >= h0 AND created_at < h1
      AND metadata->>'stage' IN (
        'greeting_sent', 'model_start_speaking', 'upstream_error', 'upstream_closed',
        'greeting_recovery', 'nova_premature_close_retry', 'reconnect_triggered',
        'watchdog_fired', 'tool_failed'
      )
  )
  INSERT INTO conversation_metrics_hourly (hour_start, metric, dimension, value, sample_count)
  SELECT h0, metric, d, COUNT(*), COUNT(*)
  FROM (
    SELECT 'diag_' || stage AS metric, '' AS d FROM diag
    UNION ALL
    SELECT 'diag_greeting_sent', 'opener:' || COALESCE(NULLIF(m->>'wake_opener', ''), 'legacy_default')
      FROM diag WHERE stage = 'greeting_sent'
    UNION ALL
    SELECT 'diag_upstream_error',
           CASE WHEN COALESCE(m->>'failure_kind', '') <> '' THEN 'kind:' || (m->>'failure_kind')
                ELSE 'code:' || COALESCE(NULLIF(m->>'code', ''), 'unknown') END
      FROM diag WHERE stage = 'upstream_error'
    UNION ALL
    SELECT 'diag_tool_failed', 'tool:' || COALESCE(NULLIF(m->>'tool', ''), 'unknown')
      FROM diag WHERE stage = 'tool_failed'
  ) x
  GROUP BY metric, d;

  -- Opener repeat rate: a greeting whose user heard the same opener in the
  -- previous 24 hours. value = repeats, sample_count = greetings with a known
  -- user; rate = value / sample_count.
  WITH g AS (
    SELECT d.created_at, d.metadata->>'session_id' AS sid,
           COALESCE(NULLIF(d.metadata->>'wake_opener', ''), 'legacy_default') AS opener
    FROM oasis_events d
    WHERE d.topic = 'orb.live.diag' AND d.created_at >= h0 - INTERVAL '24 hours' AND d.created_at < h1
      AND d.metadata->>'stage' = 'greeting_sent'
  ),
  s AS (
    SELECT DISTINCT ON (metadata->>'session_id') metadata->>'session_id' AS sid, metadata->>'user_id' AS uid
    FROM oasis_events
    WHERE topic = 'vtid.live.session.start' AND created_at >= h0 - INTERVAL '25 hours' AND created_at < h1
      AND COALESCE(metadata->>'user_id', '') <> ''
    ORDER BY metadata->>'session_id', created_at
  ),
  gu AS (SELECT g.*, s.uid FROM g JOIN s ON s.sid = g.sid),
  cur AS (
    -- A resend inside the same session (retry, reconnect) is not a repeat.
    SELECT c.uid, c.opener, c.created_at,
           EXISTS (
             SELECT 1 FROM gu p
             WHERE p.uid = c.uid AND p.opener = c.opener AND p.sid <> c.sid
               AND p.created_at < c.created_at AND p.created_at >= c.created_at - INTERVAL '24 hours'
           ) AS repeated
    FROM gu c
    WHERE c.created_at >= h0
  )
  INSERT INTO conversation_metrics_hourly (hour_start, metric, dimension, value, sample_count)
  SELECT h0, 'opener_repeat_24h', '', COUNT(*) FILTER (WHERE repeated), COUNT(*)
  FROM cur
  HAVING COUNT(*) > 0;

  -- Stall watchdog, per reason.
  INSERT INTO conversation_metrics_hourly (hour_start, metric, dimension, value, sample_count)
  SELECT h0, 'stall_detected', d, COUNT(*), COUNT(*)
  FROM (
    SELECT metadata->>'reason' AS reason
    FROM oasis_events
    WHERE topic = 'orb.live.stall_detected' AND created_at >= h0 AND created_at < h1
  ) s
  CROSS JOIN LATERAL (VALUES (''), ('reason:' || COALESCE(NULLIF(s.reason, ''), 'unknown'))) AS v(d)
  GROUP BY d;

  -- Session finalize (VTID-04353): coverage of summary, memory, continuity.
  WITH f AS (
    SELECT DISTINCT ON (metadata->>'session_id') metadata AS m
    FROM oasis_events
    WHERE topic = 'conversation.session.finalized' AND created_at >= h0 AND created_at < h1
    ORDER BY metadata->>'session_id', created_at
  )
  INSERT INTO conversation_metrics_hourly (hour_start, metric, dimension, value, sample_count)
  SELECT h0, x.metric, '', x.value, x.samples
  FROM (
    SELECT 'sessions_finalized' AS metric, COUNT(*)::float8 AS value, COUNT(*)::int AS samples FROM f
    UNION ALL
    SELECT 'finalize_summary_written', COUNT(*) FILTER (WHERE (m->>'summary_written') = 'true'), COUNT(*) FROM f
    UNION ALL
    SELECT 'finalize_memory_committed', COUNT(*) FILTER (WHERE (m->>'memory_committed') = 'true'), COUNT(*) FROM f
    UNION ALL
    SELECT 'finalize_threads_written', COALESCE(SUM(NULLIF(m->>'threads_written', '')::numeric), 0), COUNT(*) FROM f
    UNION ALL
    SELECT 'finalize_threads_touched', COALESCE(SUM(NULLIF(m->>'threads_touched', '')::numeric), 0), COUNT(*) FROM f
    UNION ALL
    SELECT 'finalize_promises_written', COALESCE(SUM(NULLIF(m->>'promises_written', '')::numeric), 0), COUNT(*) FROM f
  ) x
  WHERE x.samples > 0;

  -- Offer lifecycle (VTID-04355), per outcome and source.
  INSERT INTO conversation_metrics_hourly (hour_start, metric, dimension, value, sample_count)
  SELECT h0, 'offer_' || o.outcome, d, COUNT(*), COUNT(*)
  FROM (
    SELECT split_part(topic, '.', 3) AS outcome, metadata->>'source' AS source
    FROM oasis_events
    WHERE topic IN ('conversation.offer.made', 'conversation.offer.accepted',
                    'conversation.offer.declined', 'conversation.offer.ignored')
      AND created_at >= h0 AND created_at < h1
  ) o
  CROSS JOIN LATERAL (VALUES (''), ('source:' || COALESCE(NULLIF(o.source, ''), 'unknown'))) AS v(d)
  GROUP BY o.outcome, d;

  -- Facts learned this hour (memory_facts is small; no extracted_at index needed).
  INSERT INTO conversation_metrics_hourly (hour_start, metric, dimension, value, sample_count)
  SELECT h0, 'facts_extracted', '', COUNT(*), COUNT(DISTINCT user_id)
  FROM memory_facts
  WHERE extracted_at >= h0 AND extracted_at < h1
  HAVING COUNT(*) > 0;

  SELECT COUNT(*) INTO n FROM conversation_metrics_hourly WHERE hour_start = h0;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.conversation_metrics_rollup_hour(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_metrics_rollup_hour(TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------------------
-- conversation_metrics_backfill(p_hours) — recompute the last N full hours
-- (capped at 720). Returns the number of hours processed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.conversation_metrics_backfill(p_hours INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k INTEGER;
  cap INTEGER := LEAST(GREATEST(COALESCE(p_hours, 0), 0), 720);
BEGIN
  FOR k IN 1..cap LOOP
    PERFORM conversation_metrics_rollup_hour(date_trunc('hour', NOW()) - make_interval(hours => k));
  END LOOP;
  RETURN cap;
END;
$$;

REVOKE ALL ON FUNCTION public.conversation_metrics_backfill(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_metrics_backfill(INTEGER) TO service_role;

-- Hourly schedule: re-roll the last two full hours at :07 so late events land.
-- Best-effort, same pattern as tenant-kpi-daily-retention.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'conversation-metrics-hourly';
    PERFORM cron.schedule(
      'conversation-metrics-hourly',
      '7 * * * *',
      $cron$SELECT public.conversation_metrics_rollup_hour(date_trunc('hour', NOW()) - INTERVAL '1 hour');
            SELECT public.conversation_metrics_rollup_hour(date_trunc('hour', NOW()) - INTERVAL '2 hours');$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END$$;
