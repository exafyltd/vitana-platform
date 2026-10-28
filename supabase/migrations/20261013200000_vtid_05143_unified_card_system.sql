-- =============================================================================
-- VTID-05143 (builds VTID-05085 Phase 1) — Unified Card System: enrichment cards
-- -----------------------------------------------------------------------------
-- Plan of record: docs/validation/VTID-05085/plan-sparring.md (§3.2, §6.2, §6.3),
-- hash e7abbebb1e777f3aa27eea0356a5ca697328ee180c32a24e04150e2f5a238ab7,
-- owner-approved 2026-10-12. Build record: docs/validation/VTID-05143/.
--
--   user_enrichment_cards   one row per member per dismissed enrichment card
--                           (E1–E11). dismissed_at + cooldown_days hides the
--                           card; completion is never stored here — the
--                           gateway derives it from the source tables
--                           (no completed_at column, plan F12).
--   profiles.interests      the member's interests as stable slugs
--                           (e.g. 'fitness', 'nutrition'), never display text;
--                           the app resolves labels via screens.interests.<slug>.
--
-- Read and written by the gateway (services/gateway/src/routes/enrichment-cards.ts)
-- with service_role, always scoped to the caller's own user_id. Members may
-- read / insert / update their own rows (RLS).
--
-- Additive and idempotent (IF NOT EXISTS, DROP POLICY IF EXISTS).
-- Rollback: DROP TABLE public.user_enrichment_cards;
--           ALTER TABLE public.profiles DROP COLUMN IF EXISTS interests;
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_enrichment_cards (
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_type     TEXT        NOT NULL,
  dismissed_at  TIMESTAMPTZ DEFAULT NULL,
  cooldown_days INT         NOT NULL DEFAULT 7,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, card_type)
);

CREATE INDEX IF NOT EXISTS idx_user_enrichment_cards_user
  ON public.user_enrichment_cards (user_id);

ALTER TABLE public.user_enrichment_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own enrichment cards" ON public.user_enrichment_cards;
CREATE POLICY "Users can read own enrichment cards" ON public.user_enrichment_cards
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own enrichment cards" ON public.user_enrichment_cards;
CREATE POLICY "Users can insert own enrichment cards" ON public.user_enrichment_cards
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own enrichment cards" ON public.user_enrichment_cards;
CREATE POLICY "Users can update own enrichment cards" ON public.user_enrichment_cards
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access" ON public.user_enrichment_cards;
CREATE POLICY "Service role full access" ON public.user_enrichment_cards
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE public.user_enrichment_cards IS
  'VTID-05085 / VTID-05143 Unified Card System: per-member dismissal state of enrichment cards (E1–E11). A card stays hidden while dismissed_at + cooldown_days > now(). Completion is derived from source tables, never stored here.';

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS interests TEXT[] DEFAULT '{}';

COMMENT ON COLUMN public.profiles.interests IS
  'VTID-05085 / VTID-05143: member interests as stable slugs (e.g. fitness, nutrition), never display text. Labels resolve in the app via screens.interests.<slug>. Enrichment card E4 is complete when non-empty.';

COMMIT;
