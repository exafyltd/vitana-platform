-- Forwarding Rules — tenant variant of pick_specialist_for_text
--
-- The platform RPC was upgraded to two-gate routing in
-- 20260508001000_forwarding_rules_drop_old_rpc.sql, but tenant-scoped
-- voice sessions (the typical case for logged-in users) hit the
-- pick_specialist_for_text_tenant variant from
-- 20260501150000_vtid_02652_phase6_tenant_overrides.sql, which is still
-- keyword-only. Result: the user's "how does this work?" still routed to
-- a specialist via the tenant path even after the platform fix shipped.
--
-- This migration replaces the tenant variant with the same two-gate
-- shape (decision/persona_key/matched_phrase/gate/confidence) and ALSO
-- fixes the platform_keywords CTE to honor the tenant overlay's
-- enabled=FALSE flag — previously a tenant could "disable" a specialist
-- via the drawer but the platform handoff_keywords would still match.

DROP FUNCTION IF EXISTS public.pick_specialist_for_text_tenant(TEXT, UUID);

CREATE FUNCTION public.pick_specialist_for_text_tenant(
  p_text TEXT,
  p_tenant_id UUID
)
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
  -- Gate A override — stay-inline phrase wins outright (tenant ignores
  -- this flag; Vitana's stay-inline list is platform-wide intentionally
  -- because the rulebook framing is universal).
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

  -- Gate B — topic match across ENABLED specialists only, honoring
  -- BOTH the platform status AND the tenant overlay's enabled flag.
  -- The previous version only honored the tenant overlay on tenant_keywords,
  -- so a tenant disable left platform handoff_keywords still routing.
  WITH eligible AS (
    SELECT ap.id AS persona_id, ap.key AS persona_key, ap.handoff_keywords
    FROM public.agent_personas ap
    WHERE ap.key <> 'vitana'
      AND ap.status = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM public.agent_personas_tenant_overrides apto
        WHERE apto.tenant_id = p_tenant_id
          AND apto.persona_id = ap.id
          AND apto.enabled = FALSE
      )
  ),
  platform_keywords AS (
    SELECT
      e.persona_key,
      kw AS matched_keyword,
      array_length(e.handoff_keywords, 1) AS total_keywords,
      1.0::REAL AS weight
    FROM eligible e
    CROSS JOIN LATERAL unnest(e.handoff_keywords) AS kw
    WHERE v_lower LIKE '%' || lower(kw) || '%'
  ),
  tenant_keywords AS (
    SELECT
      e.persona_key,
      arkt.keyword AS matched_keyword,
      1 AS total_keywords,
      arkt.weight AS weight
    FROM public.agent_routing_keywords_tenant arkt
    JOIN eligible e ON e.persona_id = arkt.persona_id
    WHERE arkt.tenant_id = p_tenant_id
      AND arkt.enabled = TRUE
      AND v_lower LIKE '%' || lower(arkt.keyword) || '%'
  ),
  combined AS (
    SELECT * FROM platform_keywords
    UNION ALL
    SELECT * FROM tenant_keywords
  ),
  scored AS (
    SELECT
      c.persona_key,
      sum(c.weight)::INT AS score,
      max(c.total_keywords) AS total_keywords,
      (array_agg(c.matched_keyword ORDER BY c.weight DESC, length(c.matched_keyword) DESC))[1] AS matched_keyword
    FROM combined c
    GROUP BY c.persona_key
  )
  SELECT
    s.persona_key,
    s.matched_keyword,
    s.score,
    s.total_keywords
  INTO v_persona_key, v_topic_kw, v_score, v_total_kw
  FROM scored s
  ORDER BY s.score DESC, length(s.matched_keyword) DESC
  LIMIT 1;

  IF v_persona_key IS NULL THEN
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

GRANT EXECUTE ON FUNCTION public.pick_specialist_for_text_tenant(TEXT, UUID)
  TO authenticated, service_role;
