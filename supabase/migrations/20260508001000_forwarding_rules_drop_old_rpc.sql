-- Forwarding Rules — fix-up migration
--
-- The previous migration (20260508000000_forwarding_rules_two_gate.sql)
-- failed silently in part: ALTER TABLE / UPDATE / build_specialist_context
-- all applied, but `CREATE OR REPLACE FUNCTION pick_specialist_for_text`
-- was rejected because the existing function's RETURNS TABLE shape changed
-- (old: persona_key/matched_keyword/score/confidence; new:
-- decision/persona_key/matched_phrase/gate/confidence). Postgres can't swap
-- the return shape via CREATE OR REPLACE — you must DROP first.
--
-- This migration drops the old function and re-creates the two-gate
-- version. Idempotent: if the previous migration somehow did succeed, the
-- DROP just removes the new one and recreates it identical.

DROP FUNCTION IF EXISTS public.pick_specialist_for_text(TEXT);

CREATE FUNCTION public.pick_specialist_for_text(p_text TEXT)
RETURNS TABLE (
  decision TEXT,
  persona_key TEXT,
  matched_phrase TEXT,
  gate TEXT,
  confidence REAL
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lower       TEXT := lower(coalesce(p_text, ''));
  v_stay_phrase TEXT;
  v_fwd_phrase  TEXT;
  v_persona_key TEXT;
  v_topic_kw    TEXT;
  v_score       INT;
  v_total_kw    INT;
BEGIN
  -- Gate A override — stay-inline phrase wins outright.
  SELECT phrase INTO v_stay_phrase
  FROM (
    SELECT unnest(stay_inline_phrases) AS phrase
    FROM public.agent_personas
    WHERE key = 'vitana'
  ) s
  WHERE v_lower LIKE '%' || lower(phrase) || '%'
  ORDER BY length(phrase) DESC
  LIMIT 1;

  IF v_stay_phrase IS NOT NULL THEN
    RETURN QUERY SELECT
      'answer_inline'::TEXT,
      NULL::TEXT,
      v_stay_phrase,
      'stay_inline'::TEXT,
      0.0::REAL;
    RETURN;
  END IF;

  -- Gate A — explicit forward-request phrase must match.
  SELECT phrase INTO v_fwd_phrase
  FROM (
    SELECT unnest(forward_request_phrases) AS phrase
    FROM public.agent_personas
    WHERE key = 'vitana'
  ) f
  WHERE v_lower LIKE '%' || lower(phrase) || '%'
  ORDER BY length(phrase) DESC
  LIMIT 1;

  IF v_fwd_phrase IS NULL THEN
    RETURN QUERY SELECT
      'answer_inline'::TEXT,
      NULL::TEXT,
      NULL::TEXT,
      'forward_request'::TEXT,
      0.0::REAL;
    RETURN;
  END IF;

  -- Gate B — topic match across ENABLED specialists only.
  SELECT
    s.persona_key,
    s.matched_keyword,
    s.score,
    s.total_keywords
  INTO v_persona_key, v_topic_kw, v_score, v_total_kw
  FROM (
    SELECT
      ap.key AS persona_key,
      count(*)::INT AS score,
      max(array_length(ap.handoff_keywords, 1)) AS total_keywords,
      (array_agg(kw ORDER BY length(kw) DESC))[1] AS matched_keyword
    FROM public.agent_personas ap
    CROSS JOIN LATERAL unnest(ap.handoff_keywords) AS kw
    WHERE ap.key <> 'vitana'
      AND ap.status = 'active'
      AND v_lower LIKE '%' || lower(kw) || '%'
    GROUP BY ap.key
  ) s
  ORDER BY s.score DESC, length(s.matched_keyword) DESC
  LIMIT 1;

  IF v_persona_key IS NULL THEN
    -- Gate A passed but no enabled specialist matched the topic.
    -- Stay with Vitana and surface the gap as 'unrouted' to admins.
    RETURN QUERY SELECT
      'answer_inline'::TEXT,
      NULL::TEXT,
      v_fwd_phrase,
      'unrouted'::TEXT,
      0.0::REAL;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    'forward'::TEXT,
    v_persona_key,
    v_topic_kw,
    'topic'::TEXT,
    (v_score::REAL / GREATEST(v_total_kw, 1)::REAL);
END;
$$;

GRANT EXECUTE ON FUNCTION public.pick_specialist_for_text(TEXT) TO authenticated, service_role;
