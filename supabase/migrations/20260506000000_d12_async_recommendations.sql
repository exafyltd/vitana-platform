-- D12 async matchmaker — cache table for agent recommendations (VTID-DANCE-D12)
-- The matchmaker agent runs ~20s on Gemini 2.5 Pro. Synchronous response
-- on POST /intents would block the user. Instead we cache the agent's
-- result here, return SQL results immediately, and clients poll
-- GET /api/v1/intents/:id/matchmaker to pick up the polished output.

CREATE TABLE IF NOT EXISTS public.intent_match_recommendations (
  intent_id          uuid PRIMARY KEY REFERENCES public.user_intents(intent_id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','running','complete','error','skipped')),
  mode               text,                        -- 'solo' | 'early' | 'growth'
  pool_size          int,
  candidates         jsonb NOT NULL DEFAULT '[]'::jsonb,
  counter_questions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  voice_readback     text,
  reasoning_summary  text,
  used_fallback      boolean NOT NULL DEFAULT false,
  model              text,                        -- 'gemini-2.5-pro' | 'gemini-2.0-flash' | etc.
  latency_ms         int,
  error              text,
  computed_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS intent_match_recs_status_idx
  ON public.intent_match_recommendations (status, updated_at DESC);

COMMENT ON TABLE public.intent_match_recommendations IS
  'D12 async cache: matchmaker agent results per intent. Status pending → running → complete. Clients poll GET /api/v1/intents/:id/matchmaker for the polished re-rank.';

-- Extend intent_matches_check to allow a third valid shape: profile_match
-- (external_target_kind='profile_match', external_target_id=auth.users.id).
-- Lets profile-fallback candidates flow through the standard matches
-- pipeline (Express interest, lifecycle states, OASIS audit, etc.) instead
-- of being inlined-only in agent prompts.

ALTER TABLE public.intent_matches
  DROP CONSTRAINT IF EXISTS intent_matches_check;

ALTER TABLE public.intent_matches
  DROP CONSTRAINT IF EXISTS intent_matches_external_target_kind_check;

ALTER TABLE public.intent_matches
  ADD CONSTRAINT intent_matches_external_target_kind_check
  CHECK (external_target_kind IS NULL OR external_target_kind IN ('product','community_curated','admin_seeded','profile_match'));

ALTER TABLE public.intent_matches
  ADD CONSTRAINT intent_matches_check
  CHECK (
    (intent_b_id IS NOT NULL AND external_target_kind IS NULL)
    OR
    (intent_b_id IS NULL AND external_target_kind IS NOT NULL AND external_target_id IS NOT NULL)
    OR
    (kind_pairing = 'direct_share' AND vitana_id_b IS NOT NULL)
  );

COMMENT ON CONSTRAINT intent_matches_check ON public.intent_matches IS
  'Allows: internal pairing | external target (product/community/admin/profile_match) | direct_share. Updated 2026-04-28 to add profile_match for D11.E persisted profile fallbacks.';
