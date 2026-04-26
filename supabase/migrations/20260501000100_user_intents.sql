-- Vitana Intent Engine — P2-A · 2/9
-- VTID-01973
--
-- The single intent table that replaces the original "twin schema"
-- (service_demands + service_offerings + community_listings). All voice-
-- dictated intents land here, discriminated by intent_kind.
--
-- Why a single table:
--   - One voice flow (`post_intent`) handles all kinds.
--   - One match table (intent_matches) joins any pair.
--   - Adding a new kind later is an INSERT into intent_kinds + an extractor,
--     not a new table + new routes + new UI.
--
-- vitana_id is denormalised at insert time via a trigger that reads
-- profiles.vitana_id (Release A). The match table later joins on
-- vitana_id_a + vitana_id_b — that's the Part 1 spine the engine rides on.

CREATE TABLE IF NOT EXISTS public.user_intents (
  intent_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requester_vitana_id    text,                       -- denorm via trigger
  tenant_id              uuid NOT NULL,
  intent_kind            text NOT NULL REFERENCES public.intent_kinds(kind_key),
  category               text,                       -- FK enforced via composite check below
  title                  text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  scope                  text NOT NULL CHECK (length(scope) BETWEEN 20 AND 1500),
  kind_payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  visibility             text NOT NULL DEFAULT 'public'
                         CHECK (visibility IN ('public','tenant','private','mutual_reveal')),
  compass_alignment_at_post  text,                   -- snapshot of life_compass.category at post time
  status                 text NOT NULL DEFAULT 'open'
                         CHECK (status IN ('draft','open','matched','engaged','fulfilled','closed','cancelled')),
  match_count            int NOT NULL DEFAULT 0,
  embedding              vector(768),                -- 768 dims to match Gemini text-embedding model
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz                 -- kind-dependent default; set by trigger
);

COMMENT ON TABLE public.user_intents IS
  'Unified intent table for the Vitana Intent Engine. Every voice-dictated request lands here, discriminated by intent_kind. kind_payload JSONB carries kind-specific structured fields (budget for commercial, time_windows for activity, age_range for partner, etc.). vitana_id is denormalised via trigger. See plan: i-want-a-solution-streamed-patterson.md';

COMMENT ON COLUMN public.user_intents.kind_payload IS
  'Kind-specific structured fields. Examples: commercial_buy/sell -> {budget_min, budget_max, currency, pricing_model, location_mode, location_geo, location_label, urgency, due_date}. activity_seek -> {activity, time_windows[], location_label, group_size_pref, skill_level}. partner_seek -> {age_range, gender_preference, location_radius_km, life_stage, must_haves[], deal_breakers[]}. social_seek -> {topic, time_windows[], location_label, format_pref}. mutual_aid -> {direction, object_or_skill, duration_estimate, location_label}.';

COMMENT ON COLUMN public.user_intents.requester_vitana_id IS
  'Snapshot of profiles.vitana_id at insert time. Populated by trigger; never updated (vitana_id is permanent per Part 1 design). Reading this is faster than joining profiles for every match query.';

-- Indexes scoped per the IO playbook: keep them lean.
CREATE INDEX IF NOT EXISTS user_intents_tenant_kind_status_idx
  ON public.user_intents (tenant_id, intent_kind, status, created_at DESC)
  WHERE status IN ('open','matched','engaged');

CREATE INDEX IF NOT EXISTS user_intents_requester_status_idx
  ON public.user_intents (requester_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS user_intents_kind_category_idx
  ON public.user_intents (intent_kind, category)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS user_intents_vitana_id_idx
  ON public.user_intents (requester_vitana_id)
  WHERE requester_vitana_id IS NOT NULL;

-- HNSW vector index for the matcher's semantic similarity step.
-- Built lazily after backfill; partial to skip drafts and closed rows.
CREATE INDEX IF NOT EXISTS user_intents_embedding_hnsw_idx
  ON public.user_intents USING hnsw (embedding vector_cosine_ops)
  WHERE status IN ('open','matched','engaged') AND embedding IS NOT NULL;

-- Composite check: category, when set, must exist for this kind.
ALTER TABLE public.user_intents
  ADD CONSTRAINT user_intents_category_kind_chk
  CHECK (
    category IS NULL OR EXISTS (
      SELECT 1 FROM public.intent_categories ic
       WHERE ic.kind_key = user_intents.intent_kind
         AND ic.category_key = user_intents.category
    )
  ) NOT VALID;
-- Marked NOT VALID so existing data (none yet) doesn't block; new rows are checked.

-- Denormalisation trigger: pull vitana_id from profiles on INSERT.
-- Defensive null-tolerant: if Part 1 Release A hasn't been applied or the
-- profile row is missing, the column stays null and downstream readers fall
-- back to user_id. Same pattern Part 1 chat_messages uses.
CREATE OR REPLACE FUNCTION public.user_intents_set_vitana_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.requester_vitana_id IS NULL AND NEW.requester_user_id IS NOT NULL THEN
    SELECT p.vitana_id INTO NEW.requester_vitana_id
      FROM public.profiles p
     WHERE p.user_id = NEW.requester_user_id
     LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_intents_set_vitana_id_bi ON public.user_intents;
CREATE TRIGGER user_intents_set_vitana_id_bi
  BEFORE INSERT ON public.user_intents
  FOR EACH ROW
  EXECUTE FUNCTION public.user_intents_set_vitana_id();

-- updated_at trigger (standard pattern across the repo).
CREATE OR REPLACE FUNCTION public.user_intents_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_intents_set_updated_at_bu ON public.user_intents;
CREATE TRIGGER user_intents_set_updated_at_bu
  BEFORE UPDATE ON public.user_intents
  FOR EACH ROW
  EXECUTE FUNCTION public.user_intents_set_updated_at();

-- expires_at default: kind-dependent. partner_seek expires sooner since
-- those intents are more sensitive and should be re-confirmed periodically.
CREATE OR REPLACE FUNCTION public.user_intents_set_expires_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.expires_at IS NULL THEN
    NEW.expires_at := CASE
      WHEN NEW.intent_kind = 'partner_seek' THEN NEW.created_at + interval '60 days'
      WHEN NEW.intent_kind IN ('activity_seek','social_seek') THEN NEW.created_at + interval '30 days'
      WHEN NEW.intent_kind IN ('commercial_buy','commercial_sell') THEN NEW.created_at + interval '90 days'
      ELSE NEW.created_at + interval '180 days'
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_intents_set_expires_at_bi ON public.user_intents;
CREATE TRIGGER user_intents_set_expires_at_bi
  BEFORE INSERT ON public.user_intents
  FOR EACH ROW
  EXECUTE FUNCTION public.user_intents_set_expires_at();

-- RLS. Visibility is enforced both here and in the visibility check fn
-- (migration 8/9). Here we cover the simple cases; the helper handles
-- mutual_reveal redaction at the application layer.
ALTER TABLE public.user_intents ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_intents_owner_all ON public.user_intents
  FOR ALL
  USING (auth.uid() = requester_user_id)
  WITH CHECK (auth.uid() = requester_user_id);

CREATE POLICY user_intents_public_read ON public.user_intents
  FOR SELECT
  USING (
    visibility = 'public'
    AND status IN ('open','matched','engaged')
    AND tenant_id IN (
      SELECT m.tenant_id FROM public.memberships m
       WHERE m.user_id = auth.uid() AND m.status = 'active'
    )
  );

CREATE POLICY user_intents_tenant_read ON public.user_intents
  FOR SELECT
  USING (
    visibility = 'tenant'
    AND status IN ('open','matched','engaged')
    AND tenant_id IN (
      SELECT m.tenant_id FROM public.memberships m
       WHERE m.user_id = auth.uid() AND m.status = 'active'
    )
  );

-- mutual_reveal and private rows are NOT readable through RLS by anyone
-- but the owner. The matcher runs as service role; counterparty access
-- is gated by the route layer + intent_visibility_check_fn (migration 8).
