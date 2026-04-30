-- VTID-02047: Unified Feedback Pipeline — schema foundation (parent plan PR 1)
--
-- Creates the two backbone tables:
--   1. agent_personas — 5 voiced specialist agents (Vitana + Devon + Sage + Atlas + Mira)
--   2. feedback_tickets — single inbox for all user-originated signals
--
-- Plan: .claude/plans/unified-feedback-pipeline.md (PR 1)
-- Phase 5 management UI: .claude/plans/1-same-provider-as-greedy-hopcroft.md

-- ===========================================================================
-- 1. agent_personas — voiced specialist registry
-- ===========================================================================
-- Each row is a named persona the user hears (Vitana receptionist + 4
-- specialists). v1 ships with 5 seeded rows; later PRs add the version
-- history, tool bindings, KB bindings, and 3rd-party connection tables.

CREATE TABLE IF NOT EXISTS public.agent_personas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL                    -- 'vitana' | 'devon' | 'sage' | 'atlas' | 'mira'
    CHECK (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,                         -- short label, no backstory (per locked decision)
  voice_id TEXT,                              -- Gemini Live voice id; same provider as ORB
  voice_sample_url TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  intake_schema_ref TEXT,                     -- references structured_fields schema by kind
  handles_kinds TEXT[] NOT NULL DEFAULT '{}', -- e.g. ['bug','ux_issue']
  handoff_keywords TEXT[] NOT NULL DEFAULT '{}',
  max_questions INT NOT NULL DEFAULT 6 CHECK (max_questions BETWEEN 1 AND 20),
  max_duration_seconds INT NOT NULL DEFAULT 240 CHECK (max_duration_seconds BETWEEN 30 AND 1800),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('active','draft','disabled')),
  version INT NOT NULL DEFAULT 1,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_personas_status ON public.agent_personas (status);

-- ===========================================================================
-- 2. feedback_tickets — single inbox for all user signals
-- ===========================================================================
-- One row per user submission. Discriminator is `kind`. Status ladder is
-- documented in the parent plan (new → interviewing → triaged → spec_pending
-- → spec_ready → answer_pending → answer_ready → approved → in_progress →
-- resolved → user_confirmed, with branches duplicate / rejected / wont_fix /
-- needs_more_info).

CREATE TABLE IF NOT EXISTS public.feedback_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,                      -- auth.users.id of the reporter
  vitana_id TEXT,                             -- canonical id; resolved at insert time
  ticket_number TEXT UNIQUE,                  -- user-facing FB-YYYY-MM-NNNNNN; assigned by trigger
  kind TEXT NOT NULL DEFAULT 'feedback'
    CHECK (kind IN (
      'bug','ux_issue','support_question','account_issue',
      'marketplace_claim','feature_request','feedback'
    )),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN (
      'new','interviewing','triaged',
      'spec_pending','spec_ready',
      'answer_pending','answer_ready',
      'approved','in_progress','resolved','user_confirmed',
      'duplicate','rejected','wont_fix','needs_more_info','reopened'
    )),
  priority TEXT NOT NULL DEFAULT 'p2'
    CHECK (priority IN ('p0','p1','p2','p3')),
  surface TEXT,                               -- 'community' | 'admin' | 'command-hub' | 'mobile-only' | 'marketplace' | 'infrastructure'
  suggested_component TEXT,

  -- Capture
  raw_transcript TEXT,
  intake_messages JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{agent, role, content, ts}]
  structured_fields JSONB NOT NULL DEFAULT '{}'::jsonb, -- kind-specific schema
  screenshot_url TEXT,
  screen_path TEXT,
  app_version TEXT,
  device_meta JSONB,
  session_oasis_refs JSONB,                  -- last N OASIS events, captured at intake

  -- Classification + dedupe (filled async by classifier worker)
  embedding vector(1536),
  duplicate_of UUID REFERENCES public.feedback_tickets(id) ON DELETE SET NULL,
  similar_ticket_ids UUID[] NOT NULL DEFAULT '{}',
  classifier_meta JSONB,

  -- Resolution
  spec_md TEXT,
  draft_answer_md TEXT,
  resolution_md TEXT,
  linked_vtid TEXT,
  linked_pr_url TEXT,
  linked_kb_doc_id UUID,
  auto_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolver_agent TEXT,                       -- which persona key owned the resolution

  -- Lifecycle
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  interviewed_at TIMESTAMPTZ,
  triaged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  user_confirmed_at TIMESTAMPTZ,
  sla_due_at TIMESTAMPTZ,

  -- Supervisor
  assigned_to UUID,
  supervisor_notes TEXT,
  review_label JSONB                         -- post-hoc training labels
);

CREATE INDEX IF NOT EXISTS idx_feedback_tickets_user_created
  ON public.feedback_tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_tickets_vitana_id
  ON public.feedback_tickets (vitana_id) WHERE vitana_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_tickets_status_kind
  ON public.feedback_tickets (status, kind);
CREATE INDEX IF NOT EXISTS idx_feedback_tickets_priority_status
  ON public.feedback_tickets (priority, status) WHERE status NOT IN ('resolved','user_confirmed','rejected','wont_fix','duplicate');
CREATE INDEX IF NOT EXISTS idx_feedback_tickets_duplicate_of
  ON public.feedback_tickets (duplicate_of) WHERE duplicate_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_tickets_resolver_agent
  ON public.feedback_tickets (resolver_agent) WHERE resolver_agent IS NOT NULL;

-- ===========================================================================
-- 3. ticket_number assignment trigger
-- ===========================================================================
-- Format: FB-YYYY-MM-NNNNNN (zero-padded sequential within month).
-- Sequence is global, not per-month — simpler, still readable.

CREATE SEQUENCE IF NOT EXISTS public.feedback_ticket_seq;

CREATE OR REPLACE FUNCTION public.assign_feedback_ticket_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.ticket_number IS NULL THEN
    NEW.ticket_number := 'FB-' ||
      to_char(COALESCE(NEW.created_at, NOW()), 'YYYY-MM') || '-' ||
      lpad(nextval('public.feedback_ticket_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feedback_tickets_assign_number ON public.feedback_tickets;
CREATE TRIGGER feedback_tickets_assign_number
  BEFORE INSERT ON public.feedback_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_feedback_ticket_number();

-- ===========================================================================
-- 4. RLS — agent_personas
-- ===========================================================================
-- All authenticated users may read non-disabled personas (UI shows the team
-- to community users on first handoff). Only service_role writes.

ALTER TABLE public.agent_personas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_personas_select ON public.agent_personas;
CREATE POLICY agent_personas_select ON public.agent_personas
  FOR SELECT TO authenticated USING (status <> 'disabled');

DROP POLICY IF EXISTS agent_personas_service ON public.agent_personas;
CREATE POLICY agent_personas_service ON public.agent_personas
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT ON public.agent_personas TO authenticated;

-- ===========================================================================
-- 5. RLS — feedback_tickets
-- ===========================================================================
-- A user may read and create their own tickets (community capture surface).
-- They may NOT update (status moves are server-side). Service role does
-- everything; supervisor reads happen through service-role endpoints.

ALTER TABLE public.feedback_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feedback_tickets_select_own ON public.feedback_tickets;
CREATE POLICY feedback_tickets_select_own ON public.feedback_tickets
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS feedback_tickets_insert_own ON public.feedback_tickets;
CREATE POLICY feedback_tickets_insert_own ON public.feedback_tickets
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS feedback_tickets_service ON public.feedback_tickets;
CREATE POLICY feedback_tickets_service ON public.feedback_tickets
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

GRANT SELECT, INSERT ON public.feedback_tickets TO authenticated;
GRANT USAGE ON SEQUENCE public.feedback_ticket_seq TO authenticated;

-- ===========================================================================
-- 6. Seed personas — Vitana + Devon + Sage + Atlas + Mira
-- ===========================================================================
-- Voice IDs left NULL until Phase 5 PR 16 wires the Gemini Live voice picker.
-- system_prompt left as a placeholder; persona editor (PR 16) will fill these
-- via UI with version history. handles_kinds + handoff_keywords are the
-- minimum viable routing config for Phase 1.

INSERT INTO public.agent_personas (key, display_name, role, handles_kinds, handoff_keywords, status)
VALUES
  ('vitana', 'Vitana',
   'Longevity coach, matchmaker, community brain — and receptionist for everything off-domain.',
   ARRAY['feedback','feature_request'],
   ARRAY['report','tell','feedback','suggest']::TEXT[],
   'active'),
  ('devon', 'Devon',
   'Tech support — bugs, crashes, UX issues. Logs the report and hands to the fix pipeline.',
   ARRAY['bug','ux_issue'],
   ARRAY['bug','broken','crashed','crash','error','glitch','frozen','freeze',
         'doesn''t work','does not work','not working','app won''t','won''t load',
         'screen','button','ui','ux']::TEXT[],
   'draft'),
  ('sage', 'Sage',
   'Customer support — how-to questions, navigation help, knowledge lookups. Often resolves live in-call.',
   ARRAY['support_question'],
   ARRAY['how do i','how to','where is','where do i','what is','can i',
         'help','question','don''t understand','confused']::TEXT[],
   'draft'),
  ('atlas', 'Atlas',
   'Finance — refunds, payments, marketplace claims and disputes.',
   ARRAY['marketplace_claim'],
   ARRAY['refund','payment','charge','order','didn''t arrive','did not arrive',
         'wrong item','damaged','seller','dispute','money','price','overcharge']::TEXT[],
   'draft'),
  ('mira', 'Mira',
   'Account — login, role, profile, registration, data corrections.',
   ARRAY['account_issue'],
   ARRAY['login','log in','sign in','password','account','profile','email',
         'registration','verify','role','permission','locked out','can''t access']::TEXT[],
   'draft')
ON CONFLICT (key) DO NOTHING;
