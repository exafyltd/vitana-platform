-- =============================================================================
-- VTID-01990: Conversation tracking with timestamps — read-side RPCs
-- =============================================================================
--
-- Read-only plumbing for two new capabilities the gateway will wire up next:
--
--   1. Awareness: bucketing user_session_summaries into today / yesterday in
--      the user's local timezone, so the system prompt can say
--      "this is your 3rd session today, last at 14:20".
--
--   2. Time-anchored recall: when the user says "we talked yesterday morning
--      about X", the assistant calls a tool that resolves the time hint to a
--      [since, until] window and asks the DB for everything that happened in
--      that window (session summary + raw turns + extracted facts).
--
-- This migration is dark — no caller exists yet. The closer that produces
-- text-channel summaries, the awareness extension, and the recall tool all
-- ship in subsequent PRs against PR-1's new RPCs.
--
-- Plan: ~/.claude/plans/yes-make-a-plan-adaptive-dragon.md
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. user_sessions_today_window — timezone-correct local-day boundaries
-- =============================================================================
--
-- Given a user and an IANA timezone, return the UTC instants that bound
-- "today" and "yesterday" in that user's local day. Used by the awareness
-- builder to bucket session summaries.
--
-- Pure date math, no table reads, safe to call without RLS context.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.user_sessions_today_window(
  p_user_id UUID,
  p_user_tz TEXT DEFAULT 'UTC'
)
RETURNS TABLE (
  today_start_utc      TIMESTAMPTZ,
  today_end_utc        TIMESTAMPTZ,
  yesterday_start_utc  TIMESTAMPTZ,
  yesterday_end_utc    TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz             TEXT;
  v_local_now      TIMESTAMP;
  v_local_today    DATE;
BEGIN
  -- Defensive: unknown tz falls back to UTC. Postgres raises invalid_parameter_value
  -- if the tz is not in pg_timezone_names; we catch it.
  BEGIN
    v_local_now := (now() AT TIME ZONE p_user_tz);
    v_tz := p_user_tz;
  EXCEPTION WHEN OTHERS THEN
    v_local_now := (now() AT TIME ZONE 'UTC');
    v_tz := 'UTC';
  END;

  v_local_today := v_local_now::DATE;

  RETURN QUERY SELECT
    (v_local_today::TIMESTAMP               AT TIME ZONE v_tz)              AS today_start_utc,
    ((v_local_today + 1)::TIMESTAMP         AT TIME ZONE v_tz)              AS today_end_utc,
    ((v_local_today - 1)::TIMESTAMP         AT TIME ZONE v_tz)              AS yesterday_start_utc,
    (v_local_today::TIMESTAMP               AT TIME ZONE v_tz)              AS yesterday_end_utc;
END;
$$;

COMMENT ON FUNCTION public.user_sessions_today_window(UUID, TEXT) IS
  'VTID-01990: Returns the UTC instants that bound today and yesterday in the user''s local timezone. Used by awareness bucketing.';

GRANT EXECUTE ON FUNCTION public.user_sessions_today_window(UUID, TEXT) TO service_role;

-- =============================================================================
-- 2. recall_at_time_range — time-anchored recall payload
-- =============================================================================
--
-- Given a user and a [since, until] window (both UTC), return:
--   - up to 3 user_session_summaries whose ended_at falls in the window
--   - up to 12 conversation_messages from those threads in the window
--   - up to 8 memory_facts extracted in the window (current, not superseded)
--
-- Single round-trip; gateway shapes the result for the LLM tool reply.
-- Optional p_topic_hint biases summary ranking via array overlap on themes.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.recall_at_time_range(
  p_user_id     UUID,
  p_since       TIMESTAMPTZ,
  p_until       TIMESTAMPTZ,
  p_topic_hint  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sessions      JSONB;
  v_excerpts      JSONB;
  v_facts         JSONB;
  v_thread_ids    UUID[];
  v_topic_tokens  TEXT[];
BEGIN
  IF p_user_id IS NULL OR p_since IS NULL OR p_until IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'missing_required_param'
    );
  END IF;

  IF p_until <= p_since THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_window'
    );
  END IF;

  -- Tokenize topic hint for theme overlap ranking (lower-cased, simple split)
  IF p_topic_hint IS NOT NULL AND length(trim(p_topic_hint)) > 0 THEN
    v_topic_tokens := regexp_split_to_array(lower(trim(p_topic_hint)), '\s+');
  ELSE
    v_topic_tokens := NULL;
  END IF;

  -- Sessions in the window, ranked by topic overlap then recency
  WITH ranked_sessions AS (
    SELECT
      s.session_id,
      s.channel,
      s.summary,
      s.themes,
      s.turn_count,
      s.duration_ms,
      s.ended_at,
      CASE
        WHEN v_topic_tokens IS NULL THEN 0
        WHEN s.themes && v_topic_tokens THEN 1
        ELSE 0
      END AS topic_overlap
    FROM user_session_summaries s
    WHERE s.user_id = p_user_id
      AND s.ended_at >= p_since
      AND s.ended_at <  p_until
    ORDER BY topic_overlap DESC, s.ended_at DESC
    LIMIT 3
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'session_id',  rs.session_id,
      'channel',     rs.channel,
      'summary',     rs.summary,
      'themes',      to_jsonb(rs.themes),
      'turn_count',  rs.turn_count,
      'duration_ms', rs.duration_ms,
      'ended_at',    rs.ended_at
    )
  ), '[]'::jsonb)
  INTO v_sessions
  FROM ranked_sessions rs;

  -- Resolve thread_ids for the matched sessions (session_id is text; threads are uuid)
  SELECT COALESCE(array_agg(s.session_id::uuid) FILTER (WHERE s.session_id ~* '^[0-9a-f-]{36}$'), ARRAY[]::uuid[])
  INTO v_thread_ids
  FROM user_session_summaries s
  WHERE s.user_id = p_user_id
    AND s.ended_at >= p_since
    AND s.ended_at <  p_until;

  -- Conversation excerpts: prefer turns from the matched threads; if none,
  -- fall back to any turns the user produced in the window.
  WITH excerpts AS (
    SELECT
      cm.role,
      cm.channel,
      cm.content,
      cm.created_at
    FROM conversation_messages cm
    WHERE cm.user_id = p_user_id
      AND cm.created_at >= p_since
      AND cm.created_at <  p_until
      AND (
        cardinality(v_thread_ids) = 0
        OR cm.thread_id = ANY(v_thread_ids)
      )
    ORDER BY cm.created_at ASC
    LIMIT 12
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'role',       e.role,
      'channel',    e.channel,
      'content',    e.content,
      'created_at', e.created_at
    )
  ), '[]'::jsonb)
  INTO v_excerpts
  FROM excerpts e;

  -- Facts extracted in the window, current only
  WITH window_facts AS (
    SELECT
      f.fact_key,
      f.fact_value,
      f.fact_value_type,
      f.entity,
      f.provenance_source,
      f.provenance_confidence,
      f.extracted_at
    FROM memory_facts f
    WHERE f.user_id = p_user_id
      AND f.extracted_at >= p_since
      AND f.extracted_at <  p_until
      AND f.superseded_by IS NULL
    ORDER BY f.extracted_at ASC
    LIMIT 8
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'fact_key',                wf.fact_key,
      'fact_value',              wf.fact_value,
      'fact_value_type',         wf.fact_value_type,
      'entity',                  wf.entity,
      'provenance_source',       wf.provenance_source,
      'provenance_confidence',   wf.provenance_confidence,
      'extracted_at',            wf.extracted_at
    )
  ), '[]'::jsonb)
  INTO v_facts
  FROM window_facts wf;

  RETURN jsonb_build_object(
    'ok',       true,
    'window',   jsonb_build_object('since', p_since, 'until', p_until),
    'sessions', v_sessions,
    'excerpts', v_excerpts,
    'facts',    v_facts
  );
END;
$$;

COMMENT ON FUNCTION public.recall_at_time_range(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) IS
  'VTID-01990: Time-anchored recall. Returns matching session summaries + up to 12 conversation_messages excerpts + memory_facts extracted in the window. Used by the recall_conversation_at_time tool.';

GRANT EXECUTE ON FUNCTION public.recall_at_time_range(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO service_role;

COMMIT;
