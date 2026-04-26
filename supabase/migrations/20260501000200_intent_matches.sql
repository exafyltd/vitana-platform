-- Vitana Intent Engine — P2-A · 3/9
-- VTID-01973
--
-- The vitana_id ↔ vitana_id join table — the spine the user explicitly
-- asked for. Every match row carries BOTH speakable IDs denormalised so
-- support tooling, voice notifications, and the Command Hub admin views
-- can quote @<id> without joining profiles.
--
-- intent_b_id is NULLABLE because some matches target external sources
-- (the existing affiliate products catalog from VTID-02000); for those
-- rows external_target_kind/_id carry the pointer instead.

CREATE TABLE IF NOT EXISTS public.intent_matches (
  match_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_a_id                 uuid NOT NULL REFERENCES public.user_intents(intent_id) ON DELETE CASCADE,
  intent_b_id                 uuid REFERENCES public.user_intents(intent_id) ON DELETE CASCADE,

  -- ── The vitana_id spine (Part 1 ↔ Part 2 bridge) ────────────────
  vitana_id_a                 text NOT NULL,         -- the dictator's vitana_id (denorm)
  vitana_id_b                 text,                  -- counterparty's vitana_id (denorm) — null for external sources OR while mutual_reveal pending

  -- ── External match targets (affiliate products catalog) ─────────
  external_target_kind        text CHECK (external_target_kind IN ('product','community_curated','admin_seeded')),
  external_target_id          uuid,

  -- ── Pairing metadata ────────────────────────────────────────────
  kind_pairing                text NOT NULL,         -- e.g. 'commercial_buy::commercial_sell'
  score                       numeric(4,3) NOT NULL,
  match_reasons               jsonb NOT NULL DEFAULT '{}'::jsonb,
  compass_aligned             boolean NOT NULL DEFAULT false,

  -- ── Surfacing + lifecycle ───────────────────────────────────────
  surfaced_to_a_at            timestamptz,
  surfaced_to_b_at            timestamptz,
  mutual_reveal_unlocked_at   timestamptz,           -- null until both parties engage for mutual_reveal kinds

  state                       text NOT NULL DEFAULT 'new'
                              CHECK (state IN (
                                'new',
                                'viewed_by_a','viewed_by_b',
                                'responded_by_a','responded_by_b',
                                'mutual_interest','engaged','fulfilled','closed','declined'
                              )),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- Either intent_b_id (internal pairing) OR external target — never both, never neither.
  CHECK (
    (intent_b_id IS NOT NULL AND external_target_kind IS NULL)
    OR
    (intent_b_id IS NULL AND external_target_kind IS NOT NULL AND external_target_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.intent_matches IS
  'vitana_id ↔ vitana_id join table for the unified intent engine. Both sides denormalised for support readability and voice quotability. mutual_reveal_unlocked_at gates partner_seek visibility — see plan: i-want-a-solution-streamed-patterson.md';

COMMENT ON COLUMN public.intent_matches.vitana_id_a IS
  'Dictator''s vitana_id. The user who originally posted intent_a_id.';

COMMENT ON COLUMN public.intent_matches.vitana_id_b IS
  'Counterparty''s vitana_id. Null when the match target is an external source (affiliate product) OR when intent_a is partner_seek and mutual_reveal_unlocked_at IS NULL — in that case the route layer redacts this to null even when the underlying row has it.';

COMMENT ON COLUMN public.intent_matches.compass_aligned IS
  'true when both parties'' active Life Compass goals are in the boost matrix for this kind_pairing. Read by the notifier to prioritise surfacing and by the daily digest sort.';

-- Uniqueness: same intent pair can match only once. Across recompute runs
-- the function ON CONFLICT DO NOTHINGs, so this index is the safety net.
CREATE UNIQUE INDEX IF NOT EXISTS intent_matches_pair_unique_idx
  ON public.intent_matches (intent_a_id, intent_b_id, external_target_kind, external_target_id);

-- Surfacing query paths.
CREATE INDEX IF NOT EXISTS intent_matches_a_score_idx
  ON public.intent_matches (intent_a_id, score DESC)
  WHERE state IN ('new','viewed_by_a','responded_by_b');

CREATE INDEX IF NOT EXISTS intent_matches_b_score_idx
  ON public.intent_matches (intent_b_id, score DESC)
  WHERE state IN ('new','viewed_by_b','responded_by_a');

-- Support tooling can browse by speakable ID directly.
CREATE INDEX IF NOT EXISTS intent_matches_vitana_a_idx
  ON public.intent_matches (vitana_id_a, created_at DESC)
  WHERE vitana_id_a IS NOT NULL;

CREATE INDEX IF NOT EXISTS intent_matches_vitana_b_idx
  ON public.intent_matches (vitana_id_b, created_at DESC)
  WHERE vitana_id_b IS NOT NULL;

-- updated_at trigger (matches user_intents pattern).
CREATE OR REPLACE FUNCTION public.intent_matches_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS intent_matches_set_updated_at_bu ON public.intent_matches;
CREATE TRIGGER intent_matches_set_updated_at_bu
  BEFORE UPDATE ON public.intent_matches
  FOR EACH ROW
  EXECUTE FUNCTION public.intent_matches_set_updated_at();

-- Bump match_count on the parent intent_a (and intent_b if internal) when
-- a new match row is inserted, so the matcher knows whether to re-run on
-- the daily recompute path.
CREATE OR REPLACE FUNCTION public.intent_matches_bump_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.user_intents SET match_count = match_count + 1 WHERE intent_id = NEW.intent_a_id;
  IF NEW.intent_b_id IS NOT NULL THEN
    UPDATE public.user_intents SET match_count = match_count + 1 WHERE intent_id = NEW.intent_b_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS intent_matches_bump_count_ai ON public.intent_matches;
CREATE TRIGGER intent_matches_bump_count_ai
  AFTER INSERT ON public.intent_matches
  FOR EACH ROW
  EXECUTE FUNCTION public.intent_matches_bump_count();

-- RLS. Default: users can read rows where they're a or b. The route layer
-- handles the mutual_reveal redaction for partner_seek.
ALTER TABLE public.intent_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY intent_matches_party_a_read ON public.intent_matches
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_intents ia
       WHERE ia.intent_id = intent_matches.intent_a_id
         AND ia.requester_user_id = auth.uid()
    )
  );

CREATE POLICY intent_matches_party_b_read ON public.intent_matches
  FOR SELECT
  USING (
    intent_b_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.user_intents ib
       WHERE ib.intent_id = intent_matches.intent_b_id
         AND ib.requester_user_id = auth.uid()
    )
  );

-- Service role inserts/updates via the matcher; no broad write policy.
