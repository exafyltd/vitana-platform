-- VTID-04399 (Plan v1 WS-1.2) — conversation_metrics_rollup_hour() learns the
-- core-snapshot signals, so the WS-1.2 "done when" is measurable in the
-- Command Hub rather than by hand:
--   context_setup_empty    authenticated sessions (they waited for context)
--                          whose final upstream setup carried 0 context chars;
--                          value = empty, sample_count = sessions measured.
--   context_setup_source   per source:fresh|snapshot|none|unknown, from the
--                          context_awaited mark (unknown = code before WS-1.2).
--   diag_core_snapshot_used  the gate used the stored core snapshot.
-- Same function signature and grants; replaces the VTID-04371 body (everything
-- else is byte-identical). Re-rolls the last 168 hours so the history carries
-- the new baseline.

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
               AND (p->'detail'->>'timed_out') = 'true') AS ctx_timeouts,
           -- VTID-04399: context the final upstream setup carried, and where
           -- the gate took it from (fresh build / core snapshot / none).
           (SELECT (x.v->'detail'->>'context_chars')::numeric
              FROM jsonb_array_elements(COALESCE(e.metadata->'phases', '[]'::jsonb)) WITH ORDINALITY x(v, o)
             WHERE x.v->>'phase' = 'setup_sent'
             ORDER BY x.o DESC LIMIT 1) AS last_setup_chars,
           (SELECT x.v->'detail'->>'context_source'
              FROM jsonb_array_elements(COALESCE(e.metadata->'phases', '[]'::jsonb)) WITH ORDINALITY x(v, o)
             WHERE x.v->>'phase' = 'context_awaited'
             ORDER BY x.o LIMIT 1) AS ctx_source
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
    UNION ALL
    -- VTID-04399: sessions that waited for context (authenticated) and still
    -- set the model up with none. Anonymous sessions have no context wait.
    SELECT d, 'context_setup_empty',
           COUNT(*) FILTER (WHERE ctx_waits > 0 AND last_setup_chars = 0),
           COUNT(*) FILTER (WHERE ctx_waits > 0 AND last_setup_chars IS NOT NULL)::int
      FROM dims GROUP BY d
    UNION ALL
    SELECT 'source:' || COALESCE(NULLIF(ctx_source, ''), 'unknown'), 'context_setup_source', COUNT(*), COUNT(*)::int
      FROM lat WHERE ctx_waits > 0 GROUP BY 1
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
        'watchdog_fired', 'tool_failed', 'core_snapshot_used'
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

SELECT public.conversation_metrics_backfill(168);
