-- =============================================================================
-- Vitana integrations — v1 framework + Manual Data Entry as the first source
-- Date: 2026-04-23
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (step 9, Phase F v2+)
--
-- Every user's integrations state lives in user_integrations. The first
-- shipped integration is "manual-entry" — a direct UI path to write data
-- points into health_features_daily per pillar. Its purpose:
--   a) exercise the full Index pipeline end-to-end (user → features →
--      pillar-agent connected_data sub-score → Index) without requiring
--      a native mobile app
--   b) serve as the canonical endpoint shape that future third-party
--      integrations (Apple Health, Oura, Whoop, MyFitnessPal) plug into
--      identically
--
-- Native HealthKit / wearable sync requires either a real iOS app or a
-- third-party aggregator (Validic, Terra, Rook). Those are out of scope
-- for the WebView-only app today and are captured as roadmap.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, ON CONFLICT DO UPDATE,
-- upsert_knowledge_doc.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. user_integrations — per-user state for each integration source.
--
-- There is one system-wide row in a separate catalog table (integrations)
-- for each integration definition, but for v1 we keep things simple and
-- let user_integrations rows reference an integration_id string directly
-- (fk is logical, not enforced). Future migration can split into a proper
-- catalog if the list grows.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_integrations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  integration_id    text NOT NULL,  -- e.g., 'manual-entry', 'apple-health', 'oura', 'whoop'
  status            text NOT NULL DEFAULT 'connected'
                    CHECK (status IN ('connected', 'disconnected', 'error', 'pending')),
  connected_at      timestamptz NOT NULL DEFAULT now(),
  disconnected_at   timestamptz,
  last_sync_at      timestamptz,
  last_error        text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_integrations_unique UNIQUE (user_id, integration_id)
);

CREATE INDEX IF NOT EXISTS idx_user_integrations_user
  ON public.user_integrations (user_id, status);
CREATE INDEX IF NOT EXISTS idx_user_integrations_integration
  ON public.user_integrations (integration_id, status);

ALTER TABLE public.user_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_integrations_owner_all ON public.user_integrations;
CREATE POLICY user_integrations_owner_all
  ON public.user_integrations FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE public.user_integrations IS
  'Per-user state of each integration source (manual-entry, apple-health, oura, whoop, mfp, etc.). RLS: owner-only read/write; service_role bypasses for server-side ingestion.';

-- -----------------------------------------------------------------------------
-- 2. Ensure health_features_daily tolerates ad-hoc feature_key values that
-- the Manual Entry integration might use. Our compute RPC already queries
-- by ANY(ARRAY[...]) so unknown keys are ignored gracefully — no schema
-- change needed. The UNIQUE (tenant_id, user_id, date, feature_key) gives
-- upsert semantics per pillar per day.
-- -----------------------------------------------------------------------------
-- (no-op; declarative note only)

-- -----------------------------------------------------------------------------
-- 3. Book of the Vitana Index — chapter 11: Connecting data sources.
-- -----------------------------------------------------------------------------
SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — Connecting data sources',
  p_path  := 'kb/vitana-system/index-book/11-connecting-data-sources.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','integrations','data-sources','maxina'],
  p_content := $CONTENT$
# Connecting data sources

Your Vitana Index is only as rich as the data it sees. The Connected
Data sub-score on each pillar (max 40 per pillar) fills in when real
signals flow into your account — wearables, food logs, lab results,
meditation apps, and so on.

Each pillar agent watches for its own pillar-specific feature keys. The
more sources connect, the higher that pillar's `connected_data` bar
climbs.

## What's connected today

### Manual Data Entry
Connected for every user by default. Lets you log data points directly
from the Index Detail Screen:

- Water intake (Hydration)
- Exercise minutes or workouts (Exercise)
- Sleep hours (Sleep)
- Meditation minutes (Mental)
- Meal entries, glucose readings (Nutrition)

Each log writes into `health_features_daily`. The pillar agents
re-compute and the corresponding Connected Data segment on that pillar
grows.

## What's on the roadmap

Integrations planned per pillar (from each agent's
`integrations_planned` metadata in the Agents Registry):

### Nutrition
- Apple Health (Nutrition)
- Google Fit (Nutrition)
- MyFitnessPal
- Cronometer
- Lab-report OCR (HbA1c, lipid panels, vitamin D)
- USDA FoodData + OpenFoodFacts (barcode lookup)

### Hydration
- HidrateSpark smart bottles
- Apple Health (Water)
- Google Fit (Hydration)
- OpenWeatherMap (climate-adjusted daily targets)

### Exercise
- Apple Health, Google Fit
- Strava, Whoop, Oura, Garmin Connect, Fitbit, Polar

### Sleep
- Oura, Whoop, Eight Sleep
- Apple Sleep, Fitbit Sleep, Garmin Sleep

### Mental
- Calm, Headspace
- Oura (readiness + HRV stress)
- Apple Health (Mindful Minutes)

## How an integration connects

1. You tap **Connect** on the Connected Sources panel.
2. You grant permission to the source (OAuth for third parties, or a
   confirmation for manual entry).
3. Vitana writes a row to `user_integrations` with status
   `connected` and starts listening for data.
4. As data arrives, the relevant pillar agent(s) ingest it and the
   Connected Data segment of that pillar grows. The Balance chip keeps
   your pillars honest.

## Why native mobile matters for the big list

Apple Health, Oura, Whoop and most wearables require native iOS or
Android access to read your health data. The current Vitana app is a
WebView wrapper which cannot read HealthKit. Two paths unlock them:

1. **Native mobile app** — a real iOS/Android app with HealthKit /
   Health Connect permissions. Biggest effort, most reliable.
2. **Third-party aggregator** — Validic, Terra, Rook. You grant them
   access once; they sync every wearable. Ships faster but adds a
   partner dependency.

Either path posts the same shape into Vitana's `/api/v1/integrations/:source/ingest`
endpoint, so the backend doesn't change — only the source of the
stream does.

## See also
- [Your five agents](kb/vitana-system/index-book/10-your-five-agents.md)
- [Reading your number](kb/vitana-system/index-book/08-reading-your-number.md)
$CONTENT$
);

COMMIT;
