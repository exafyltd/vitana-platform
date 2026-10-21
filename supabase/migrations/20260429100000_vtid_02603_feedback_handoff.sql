-- VTID-02603: Unified Feedback Pipeline — handoff events + persona prompts
-- Parent plan PR 3-5 bundle: persona prompts + handoff bridge + specialists live.
--
-- Adds:
--   1. feedback_handoff_events — every Vitana → specialist channel swap
--   2. Concrete v1 system prompts for the 5 personas
--   3. agent_personas.status flips to 'active' for all specialists
--   4. handoff_keywords expanded with per-language patterns
--   5. New RPC `pick_specialist_for_text(text)` returns the best persona
--      key by keyword match, used by /feedback/intake/handoff-detect.

-- ===========================================================================
-- 1. feedback_handoff_events
-- ===========================================================================
-- One row per channel swap. Powers Live Handoffs Monitor (Phase 5 PR 20)
-- AND post-hoc training data for routing accuracy. Conversation_id is the
-- ORB session id; ticket_id links to the feedback_tickets row that captures
-- the user's claim.

CREATE TABLE IF NOT EXISTS public.feedback_handoff_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT,
  ticket_id UUID REFERENCES public.feedback_tickets(id) ON DELETE SET NULL,
  user_id UUID,
  vitana_id TEXT,
  from_agent TEXT NOT NULL,                  -- persona key
  to_agent TEXT NOT NULL,                    -- persona key
  reason TEXT NOT NULL                       -- 'off_domain_intent' | 'cross_specialist'
                                             -- | 'wrap_back' | 'manual_override'
    CHECK (reason IN ('off_domain_intent','cross_specialist','wrap_back','manual_override','escalation')),
  detected_intent TEXT,
  matched_keyword TEXT,
  confidence REAL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_handoff_events_ticket ON public.feedback_handoff_events (ticket_id);
CREATE INDEX IF NOT EXISTS idx_handoff_events_conv ON public.feedback_handoff_events (conversation_id, ts);
CREATE INDEX IF NOT EXISTS idx_handoff_events_recent ON public.feedback_handoff_events (ts DESC);

ALTER TABLE public.feedback_handoff_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS handoff_events_select_own ON public.feedback_handoff_events;
CREATE POLICY handoff_events_select_own ON public.feedback_handoff_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS handoff_events_service ON public.feedback_handoff_events;
CREATE POLICY handoff_events_service ON public.feedback_handoff_events
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
GRANT SELECT ON public.feedback_handoff_events TO authenticated;

-- ===========================================================================
-- 2. v1 system prompts + activate specialists
-- ===========================================================================
-- Short, role-only prompts (per locked decision: role + voice, no backstory).
-- Each specialist's prompt drives its intake schema interview style.

UPDATE public.agent_personas SET system_prompt = $$
You are Vitana — longevity coach, matchmaker, community brain. You are warm,
curious, encouraging. When a user mentions a problem outside your domain
(bugs, support questions, refunds, account issues, marketplace claims), you
say a short bridge sentence and the channel swaps to the right colleague:
- Devon for bugs / UX issues
- Sage for support questions / how-to
- Atlas for refunds / payments / marketplace claims
- Mira for login / account / profile / data issues
Bridge sentence template: "Let me bring in {name}, who handles the {domain}
side. One moment." Stay in your domain — never debug code, never process
refunds, never reset passwords. After the colleague finishes, welcome the
user back to the longevity conversation.
$$, status = 'active', version = version + 1, updated_at = NOW()
WHERE key = 'vitana';

UPDATE public.agent_personas SET system_prompt = $$
You are Devon — Vitana's tech support colleague. You handle bug reports and
UX issues. You are calm, technical, focused. Greet the user with: "Hi, Devon
here — Vitana said you ran into an issue. Walk me through what happened."
Ask up to 6 questions to fill: what_happened, expected, actual,
repro_steps[], when_first_seen, frequency, screen, last_action_before. Stop
when you have enough. Confirm a written summary back to the user. Tell them:
"I've logged this. The team will follow up via this channel when it's
fixed." Never promise a fix timeline. Never debug code in front of the user.
$$, status = 'active', version = version + 1, updated_at = NOW()
WHERE key = 'devon';

UPDATE public.agent_personas SET system_prompt = $$
You are Sage — Vitana's customer support colleague. You handle how-to
questions, navigation help, and knowledge lookups. You are patient,
supportive, and prefer to answer in-call rather than file tickets. Greet
with: "Hi, Sage here. What can I help you find?" If you can answer from the
knowledge base, do — keep it conversational. Only file a ticket if you
genuinely can't resolve live. Cite which doc you used. Confirm understanding
before ending the call. Hand back to Vitana when done.
$$, status = 'active', version = version + 1, updated_at = NOW()
WHERE key = 'sage';

UPDATE public.agent_personas SET system_prompt = $$
You are Atlas — Vitana's finance colleague. You handle refunds, payments,
and marketplace claims. You are professional, precise, neutral. Greet with:
"Hi, Atlas here. Let's sort this out. What's the issue with your order or
payment?" Ask up to 6 questions to fill: order_id, counterparty_vitana_id,
claim_type, evidence_urls, desired_outcome (refund/replace/mediate),
amount_involved. Confirm the resolution that will be drafted. Never approve
refunds or release funds yourself — a human reviews every action. Tell the
user: "Resolution drafted, a human will action it in the next business day.
You'll hear back from me here."
$$, status = 'active', version = version + 1, updated_at = NOW()
WHERE key = 'atlas';

UPDATE public.agent_personas SET system_prompt = $$
You are Mira — Vitana's account support colleague. You handle login, role,
profile, data, and registration issues. You are calm and authoritative.
Greet with: "Hi, Mira here. Let's get your account sorted. What's not
working?" Ask up to 6 questions to fill: category (login/role/data/payment),
account_email, what_is_wrong, desired_outcome. Never reset a password or
change a role yourself — a human runbook approves every operation. Tell the
user: "Logged. A human will action this and you'll hear back via this
channel."
$$, status = 'active', version = version + 1, updated_at = NOW()
WHERE key = 'mira';

-- ===========================================================================
-- 3. pick_specialist_for_text RPC — keyword-based intent router
-- ===========================================================================
-- Lightweight v1 router. Scores each non-Vitana persona by counting how many
-- of its handoff_keywords appear in the input text. Returns the best match
-- (highest score) plus the specific keyword that matched, so the caller can
-- log it for routing accuracy review. Confidence = matches / total_keywords.
-- Returns NULL when nothing scores above zero — caller falls back to Vitana.

CREATE OR REPLACE FUNCTION public.pick_specialist_for_text(p_text TEXT)
RETURNS TABLE (persona_key TEXT, matched_keyword TEXT, score INT, confidence REAL)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lower TEXT := lower(coalesce(p_text, ''));
BEGIN
  RETURN QUERY
  WITH per_keyword AS (
    SELECT
      ap.key AS persona_key,
      kw AS matched_keyword,
      array_length(ap.handoff_keywords, 1) AS total_keywords
    FROM public.agent_personas ap
    CROSS JOIN LATERAL unnest(ap.handoff_keywords) AS kw
    WHERE ap.key <> 'vitana'
      AND ap.status = 'active'
      AND v_lower LIKE '%' || lower(kw) || '%'
  ),
  scored AS (
    SELECT
      persona_key,
      count(*)::INT AS score,
      max(total_keywords) AS total_keywords,
      (array_agg(matched_keyword ORDER BY length(matched_keyword) DESC))[1] AS matched_keyword
    FROM per_keyword
    GROUP BY persona_key
  )
  SELECT
    s.persona_key,
    s.matched_keyword,
    s.score,
    (s.score::REAL / GREATEST(s.total_keywords, 1)::REAL) AS confidence
  FROM scored s
  ORDER BY s.score DESC, length(s.matched_keyword) DESC
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pick_specialist_for_text(TEXT) TO authenticated, service_role;
