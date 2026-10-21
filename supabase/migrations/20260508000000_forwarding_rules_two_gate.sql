-- Forwarding Rules + Two-Gate Routing + Shared Specialist Context
--
-- Plan: .claude/plans/the-logic-for-forwarding-zippy-octopus.md
--
-- Background: Vitana has been forwarding to specialists too aggressively. A
-- single keyword match (e.g. "how do i", "help", "question") was enough to
-- trigger a handoff to Sage even when the user just wanted Vitana to answer.
--
-- This migration moves the forwarding rule out of code into editable data on
-- the `vitana` row of `agent_personas`, and replaces the topic-only
-- pick_specialist_for_text RPC with a two-gate version:
--
--   Gate A — Explicit-request gate (vitana.forward_request_phrases) +
--            Stay-inline override (vitana.stay_inline_phrases)
--   Gate B — Topic match against ENABLED specialists (status='active')
--
-- It also adds build_specialist_context(p_user_id) — a single shared payload
-- (identity + ALL ticket history with `owner` derived from handles_kinds)
-- injected into every specialist's prompt at swap time so any agent can
-- discuss any ticket on first contact.

-- ===========================================================================
-- 1. agent_personas: forwarding-rule columns on Vitana's row
-- ===========================================================================

ALTER TABLE public.agent_personas
  ADD COLUMN IF NOT EXISTS forward_request_phrases TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS stay_inline_phrases     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN public.agent_personas.forward_request_phrases IS
  'Gate A. Phrases that signal the user EXPLICITLY wants to be connected to a specialist. Only consulted on the vitana row. Lowercase, partial-match (LIKE).';
COMMENT ON COLUMN public.agent_personas.stay_inline_phrases IS
  'Gate A override. Phrases that force the conversation to stay with Vitana even if Gate A would otherwise pass. Only consulted on the vitana row. Lowercase, partial-match (LIKE).';

-- ===========================================================================
-- 2. Seed Vitana's defaults — forward triggers + stay-inline overrides
-- ===========================================================================
-- The default rulebook the user dictated. Vitana is the life companion;
-- forwarding is the rare exception. These lists encode that:
--   forward_request_phrases = "I clearly want to be connected"
--   stay_inline_phrases     = "I have a question, you answer it"

UPDATE public.agent_personas
SET
  forward_request_phrases = ARRAY[
    -- English — explicit handoff requests
    'talk to support',
    'talk to customer support',
    'talk to a specialist',
    'talk to someone',
    'speak to support',
    'speak to a specialist',
    'speak to someone',
    'connect me',
    'connect me to',
    'put me through to',
    'transfer me',
    'i want to report',
    'i want to file',
    'i would like to report',
    'i would like to file',
    'i have a bug report',
    'i have a bug',
    'i have a claim',
    'i have a complaint',
    'file a complaint',
    'file a claim',
    'file a bug',
    'open a ticket',
    'escalate this',
    'i need a refund',
    'my account is locked',
    'i can''t log in',
    -- Direct specialist invocation
    'i want to talk to devon',
    'i want to talk to sage',
    'i want to talk to atlas',
    'i want to talk to mira',
    -- German — same intents
    'mit dem support sprechen',
    'mit dem kundendienst sprechen',
    'kundendienst',
    'verbinde mich',
    'verbinde mich mit',
    'fehler melden',
    'einen fehler melden',
    'reklamation',
    'beschwerde',
    'eine beschwerde',
    'ich möchte melden',
    'ich möchte einreichen',
    'ich brauche eine rückerstattung',
    'mein konto ist gesperrt'
  ]::TEXT[],
  stay_inline_phrases = ARRAY[
    -- English — life-companion question patterns Vitana answers herself
    'i have a question',
    'just a question',
    'a quick question',
    'can you tell me',
    'could you tell me',
    'are you able to',
    'do you know',
    'how does this work',
    'how does that work',
    'how do i use',
    'how do i find',
    'what is',
    'what are',
    'tell me about',
    'tell me more',
    'explain',
    'i would like to know',
    'i want to know',
    'help me understand',
    -- German — same intents
    'eine frage',
    'ich habe eine frage',
    'kannst du mir sagen',
    'kannst du mir erklären',
    'erkläre mir',
    'wie funktioniert',
    'wie funktioniert das',
    'was ist',
    'was sind',
    'erzähl mir',
    'ich möchte wissen',
    'hilf mir zu verstehen'
  ]::TEXT[],
  version = version + 1,
  updated_at = NOW()
WHERE key = 'vitana';

-- ===========================================================================
-- 3. Prune misleading Sage keywords
-- ===========================================================================
-- Sage's seed included 'how do i', 'how to', 'where is', 'where do i',
-- 'what is', 'can i', 'help', 'question', 'don''t understand', 'confused' —
-- ALL of which fire on normal life-companion questions. With Gate A
-- requiring an explicit forward request these would mostly be inert, but
-- keeping them invites bypass. They belong in stay_inline_phrases on
-- Vitana, not in Sage's topic keywords. Sage's remaining keywords stay
-- focused on customer-support escalation intents that already passed Gate A.

UPDATE public.agent_personas
SET handoff_keywords = ARRAY[
  'how-to article',
  'documentation',
  'guide',
  'tutorial',
  'instructions',
  'walk me through',
  'step by step',
  'where in the app',
  'feature request',
  'where is the setting',
  'general support'
]::TEXT[],
    version = version + 1,
    updated_at = NOW()
WHERE key = 'sage';

-- ===========================================================================
-- 4. pick_specialist_for_text v2 — two-gate router
-- ===========================================================================
-- Returns:
--   decision        'answer_inline' | 'forward'
--   persona_key     target specialist (NULL when answer_inline)
--   matched_phrase  the phrase that fired (Gate A or Gate B)
--   gate            'stay_inline' | 'forward_request' | 'topic' | 'unrouted'
--   confidence      score for Gate B (0.0 for Gate A outcomes)
--
-- gate semantics:
--   'stay_inline'      Gate A override fired; Vitana keeps the user.
--   'forward_request'  Gate A did NOT pass (no explicit request). Default.
--                      decision='answer_inline'.
--   'topic'            Both gates passed; specialist resolved.
--   'unrouted'         Gate A passed but no ENABLED specialist matched.
--                      Stay with Vitana; admin sees the gap in Live Handoffs.

CREATE OR REPLACE FUNCTION public.pick_specialist_for_text(p_text TEXT)
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

-- ===========================================================================
-- 5. build_specialist_context(p_user_id) — shared identity + ticket history
-- ===========================================================================
-- Same payload for EVERY persona (Vitana + all specialists). No domain
-- scoping on visibility — specialization is authority, not access. Each
-- ticket carries `owner` (the persona key responsible for action) so the
-- agent can hand off by name when an action is outside its authority.
--
-- Capped at: all open tickets + last 5 resolved across all kinds.

CREATE OR REPLACE FUNCTION public.build_specialist_context(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_display_name TEXT;
  v_vitana_id    TEXT;
  v_tenure_days  INT;
  v_total        INT;
  v_open         INT;
  v_resolved     INT;
  v_rejected     INT;
  v_open_json    JSONB;
  v_resolved_json JSONB;
BEGIN
  -- Identity (display_name + vitana_id handle, never the UUID).
  SELECT
    COALESCE(au.display_name, split_part(au.email, '@', 1)),
    au.vitana_id,
    GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - au.created_at)) / 86400)::INT)
  INTO v_display_name, v_vitana_id, v_tenure_days
  FROM public.app_users au
  WHERE au.user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'user', jsonb_build_object('display_name', NULL, 'vitana_id', NULL, 'tenure_days', 0),
      'ticket_counts', jsonb_build_object('total', 0, 'open', 0, 'resolved', 0, 'rejected', 0),
      'open_tickets', '[]'::jsonb,
      'recent_resolved', '[]'::jsonb
    );
  END IF;

  -- Counts across ALL kinds.
  SELECT
    count(*)::INT,
    count(*) FILTER (
      WHERE status NOT IN ('resolved','user_confirmed','duplicate','rejected','wont_fix')
    )::INT,
    count(*) FILTER (WHERE status IN ('resolved','user_confirmed'))::INT,
    count(*) FILTER (WHERE status IN ('rejected','wont_fix','duplicate'))::INT
  INTO v_total, v_open, v_resolved, v_rejected
  FROM public.feedback_tickets
  WHERE user_id = p_user_id;

  -- Open tickets — all of them, with `owner` derived from handles_kinds.
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
  INTO v_open_json
  FROM (
    SELECT
      ft.id,
      ft.ticket_number,
      ft.kind,
      COALESCE(
        ft.structured_fields->>'summary',
        NULLIF(left(ft.raw_transcript, 200), ''),
        'Open ticket'
      ) AS summary,
      ft.created_at,
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - ft.created_at)) / 86400)::INT) AS age_days,
      (
        SELECT ap.key
        FROM public.agent_personas ap
        WHERE ap.key <> 'vitana'
          AND ft.kind = ANY(ap.handles_kinds)
        ORDER BY (ap.status = 'active') DESC, ap.updated_at DESC
        LIMIT 1
      ) AS owner
    FROM public.feedback_tickets ft
    WHERE ft.user_id = p_user_id
      AND ft.status NOT IN ('resolved','user_confirmed','duplicate','rejected','wont_fix')
    ORDER BY ft.created_at DESC
  ) t;

  -- Last 5 resolved across ALL kinds.
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
  INTO v_resolved_json
  FROM (
    SELECT
      ft.id,
      ft.ticket_number,
      ft.kind,
      COALESCE(
        ft.structured_fields->>'summary',
        NULLIF(left(ft.raw_transcript, 200), ''),
        'Resolved ticket'
      ) AS summary,
      ft.resolved_at,
      (
        SELECT ap.key
        FROM public.agent_personas ap
        WHERE ap.key <> 'vitana'
          AND ft.kind = ANY(ap.handles_kinds)
        ORDER BY (ap.status = 'active') DESC, ap.updated_at DESC
        LIMIT 1
      ) AS owner
    FROM public.feedback_tickets ft
    WHERE ft.user_id = p_user_id
      AND ft.status IN ('resolved','user_confirmed')
      AND ft.resolved_at IS NOT NULL
    ORDER BY ft.resolved_at DESC
    LIMIT 5
  ) t;

  RETURN jsonb_build_object(
    'user', jsonb_build_object(
      'display_name', v_display_name,
      'vitana_id', v_vitana_id,
      'tenure_days', v_tenure_days
    ),
    'ticket_counts', jsonb_build_object(
      'total', v_total,
      'open', v_open,
      'resolved', v_resolved,
      'rejected', v_rejected
    ),
    'open_tickets', v_open_json,
    'recent_resolved', v_resolved_json
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.build_specialist_context(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.build_specialist_context(UUID) IS
  'Single shared context payload (identity + ALL ticket history) injected into every persona prompt at swap time. Same payload regardless of which persona is receiving the call.';
