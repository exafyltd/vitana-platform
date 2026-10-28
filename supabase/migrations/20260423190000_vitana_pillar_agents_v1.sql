-- =============================================================================
-- Vitana pillar agents — v1 framework (BOOTSTRAP-VITANA-PILLAR-AGENTS-V1)
-- Date: 2026-04-23
-- Plan: .claude/plans/community-user-role-make-purring-pascal.md (step 8, Phase F v1)
--
-- First cut of the 5-pillar-agent architecture. One agent per pillar —
-- Nutrition, Hydration, Exercise, Sleep, Mental — registered as 'embedded'
-- agents in agents_registry. Each agent writes its per-user, per-day
-- sub-score breakdown into vitana_pillar_agent_outputs for observability
-- and to enable future compute-RPC swap (Phase F v2+).
--
-- v1 agents just mirror the compute RPC's sub-score math for their pillar,
-- wrapped in a module. The framework + registration is what matters — v2+
-- replaces each agent's internals with external integrations (Apple Health,
-- Oura, Whoop, food-log apps, etc.) and LLM enrichment.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, ON CONFLICT DO UPDATE, upsert_knowledge_doc.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. vitana_pillar_agent_outputs — per-user, per-day, per-pillar agent output.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vitana_pillar_agent_outputs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pillar          text NOT NULL CHECK (pillar IN ('nutrition','hydration','exercise','sleep','mental')),
  date            date NOT NULL,
  -- Agent output payload: sub-score breakdown + any extras the agent wants
  -- to expose (signals, narratives, suggested actions). Always JSONB so
  -- agents can evolve without schema changes.
  outputs_jsonb   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Computed sub-scores for fast lookup by the RPC.
  subscore_baseline    smallint DEFAULT 0 CHECK (subscore_baseline    BETWEEN 0 AND 40),
  subscore_completions smallint DEFAULT 0 CHECK (subscore_completions BETWEEN 0 AND 80),
  subscore_data        smallint DEFAULT 0 CHECK (subscore_data        BETWEEN 0 AND 40),
  subscore_streak      smallint DEFAULT 0 CHECK (subscore_streak      BETWEEN 0 AND 40),
  agent_version   text NOT NULL DEFAULT 'v1',
  computed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vitana_pillar_agent_outputs_unique UNIQUE (user_id, pillar, date)
);

CREATE INDEX IF NOT EXISTS idx_vitana_pillar_agent_outputs_user_date
  ON public.vitana_pillar_agent_outputs (user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_vitana_pillar_agent_outputs_pillar_date
  ON public.vitana_pillar_agent_outputs (pillar, date DESC);

ALTER TABLE public.vitana_pillar_agent_outputs ENABLE ROW LEVEL SECURITY;

-- Users can see their own outputs (useful for debug/transparency on the
-- Index Detail screen if we ever surface them).
DROP POLICY IF EXISTS vitana_pillar_agent_outputs_owner_read ON public.vitana_pillar_agent_outputs;
CREATE POLICY vitana_pillar_agent_outputs_owner_read
  ON public.vitana_pillar_agent_outputs FOR SELECT
  USING (user_id = auth.uid());

COMMENT ON TABLE public.vitana_pillar_agent_outputs IS
  'Per-user, per-day, per-pillar output from the 5 Vitana pillar agents. Owned by the agent framework (services/gateway/src/services/pillar-agents/). RLS: users read their own rows; service_role writes.';

-- -----------------------------------------------------------------------------
-- 2. Register the 5 pillar agents in agents_registry.
-- -----------------------------------------------------------------------------
INSERT INTO public.agents_registry
  (agent_id, display_name, description, tier, role, llm_provider, llm_model,
   source_path, health_endpoint, metadata)
VALUES
  ('pillar-nutrition-agent',
   'Pillar Agent — Nutrition',
   'Observes the Nutrition pillar: meal logs, macro balance, biomarkers (glucose, HbA1c, lipids). Writes per-day sub-score breakdown to vitana_pillar_agent_outputs. v1 mirrors the compute RPC math; v2+ adds external integrations (MyFitnessPal, Cronometer, Apple Health Nutrition, lab-report OCR).',
   'embedded', 'pillar-scoring', 'none', NULL,
   'services/gateway/src/services/pillar-agents/nutrition/', '/api/v1/pillar-agents/health',
   jsonb_build_object(
     'pillar', 'nutrition',
     'version', 'v1',
     'integrations_planned', jsonb_build_array('MyFitnessPal','Cronometer','Apple Health (Nutrition)','Google Fit (Nutrition)','USDA FoodData','OpenFoodFacts','lab-report OCR')
   )),
  ('pillar-hydration-agent',
   'Pillar Agent — Hydration',
   'Observes the Hydration pillar: water intake, activity- and climate-adjusted targets. Writes per-day sub-score breakdown to vitana_pillar_agent_outputs. v1 mirrors the compute RPC; v2+ adds smart-bottle + health-app integrations.',
   'embedded', 'pillar-scoring', 'none', NULL,
   'services/gateway/src/services/pillar-agents/hydration/', '/api/v1/pillar-agents/health',
   jsonb_build_object(
     'pillar', 'hydration',
     'version', 'v1',
     'integrations_planned', jsonb_build_array('HidrateSpark','Apple Health (Water)','Google Fit (Hydration)','OpenWeatherMap')
   )),
  ('pillar-exercise-agent',
   'Pillar Agent — Exercise',
   'Observes the Exercise pillar: movement, heart rate, workouts, recovery signals. Writes per-day sub-score breakdown to vitana_pillar_agent_outputs. v1 mirrors the compute RPC; v2+ ingests wearable data (Apple Health, Google Fit, Strava, Whoop, Oura, Garmin, Fitbit, Polar).',
   'embedded', 'pillar-scoring', 'none', NULL,
   'services/gateway/src/services/pillar-agents/exercise/', '/api/v1/pillar-agents/health',
   jsonb_build_object(
     'pillar', 'exercise',
     'version', 'v1',
     'integrations_planned', jsonb_build_array('Apple Health','Google Fit','Strava','Whoop','Oura','Garmin Connect','Fitbit','Polar')
   )),
  ('pillar-sleep-agent',
   'Pillar Agent — Sleep',
   'Observes the Sleep pillar: duration, stages, HRV, circadian alignment. Writes per-day sub-score breakdown to vitana_pillar_agent_outputs. v1 mirrors the compute RPC; v2+ reads wearable sleep data.',
   'embedded', 'pillar-scoring', 'none', NULL,
   'services/gateway/src/services/pillar-agents/sleep/', '/api/v1/pillar-agents/health',
   jsonb_build_object(
     'pillar', 'sleep',
     'version', 'v1',
     'integrations_planned', jsonb_build_array('Oura','Whoop','Eight Sleep','Apple Sleep','Fitbit Sleep','Garmin Sleep')
   )),
  ('pillar-mental-agent',
   'Pillar Agent — Mental',
   'Observes the Mental pillar: stress, mood, mindfulness, cognitive load. Writes per-day sub-score breakdown to vitana_pillar_agent_outputs. v1 mirrors the compute RPC; v2+ integrates journaling, HRV stress analysis, meditation apps.',
   'embedded', 'pillar-scoring', 'none', NULL,
   'services/gateway/src/services/pillar-agents/mental/', '/api/v1/pillar-agents/health',
   jsonb_build_object(
     'pillar', 'mental',
     'version', 'v1',
     'integrations_planned', jsonb_build_array('Calm','Headspace','Oura (readiness)','Apple Health (Mindful Minutes)','mood-tracking apps')
   ))
ON CONFLICT (agent_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  source_path = EXCLUDED.source_path,
  health_endpoint = EXCLUDED.health_endpoint,
  metadata = EXCLUDED.metadata,
  updated_at = now();

-- -----------------------------------------------------------------------------
-- 3. Book of the Vitana Index — chapter 10: Your five agents.
-- -----------------------------------------------------------------------------
SELECT public.upsert_knowledge_doc(
  p_title := 'Book of the Vitana Index — Your five agents',
  p_path  := 'kb/vitana-system/index-book/10-your-five-agents.md',
  p_source_type := 'markdown',
  p_tags  := ARRAY['vitana_system','vitana-index','index-book','agents','pillar-agents','maxina'],
  p_content := $CONTENT$
# Your five agents

Five specialised agents watch your Vitana Index on your behalf — one per
pillar. They run inside the Vitana platform and keep your pillar
scores honest, live, and rising as you engage with the 90-day journey.

## The five

| Agent | Pillar it owns |
|---|---|
| **Pillar Agent — Nutrition** | Nutrition |
| **Pillar Agent — Hydration** | Hydration |
| **Pillar Agent — Exercise** | Exercise |
| **Pillar Agent — Sleep** | Sleep |
| **Pillar Agent — Mental** | Mental |

Each agent is an independent software module — visible in the admin
"Agents Registry" dashboard with a live heartbeat — that does one
thing well for its pillar. Over time, each agent grows its toolbelt
(see "Integrations" below).

## What each agent does today (v1)

- Computes its pillar's four sub-scores (baseline / completions /
  connected data / streak) from the data already in your Vitana
  account.
- Writes a per-day output record so you can see the sub-score breakdown
  on the Index Detail Screen.
- Heartbeats into the agent registry so the admin dashboard can monitor
  health.

In v1, the agents mirror the compute engine's math. The value of the
framework is that future work — LLM enrichment, third-party
integrations, personalised coaching per pillar — plugs in behind the
agent boundary without changing the rest of the system.

## What each agent will do next (v2 and beyond)

Each agent has a planned integration roadmap. See the Agent Registry
metadata (`integrations_planned`) for the canonical list.

**Pillar Agent — Nutrition**
- MyFitnessPal, Cronometer (food log imports)
- Apple Health / Google Fit (Nutrition)
- USDA FoodData + OpenFoodFacts (barcode / ingredient lookup)
- Lab-report OCR (HbA1c, lipid panels, vitamin D)
- LLM meal-photo analysis

**Pillar Agent — Hydration**
- HidrateSpark (smart bottles)
- Apple Health (Water) / Google Fit (Hydration)
- OpenWeatherMap (climate-adjusted daily targets)

**Pillar Agent — Exercise**
- Apple Health, Google Fit
- Strava, Whoop, Oura, Garmin Connect, Fitbit, Polar
- VO2-max estimation, zone-2 vs. HIIT detection

**Pillar Agent — Sleep**
- Oura, Whoop, Eight Sleep
- Apple Sleep, Fitbit Sleep, Garmin Sleep
- Personalised sleep-hygiene review

**Pillar Agent — Mental**
- Calm, Headspace (meditation logs)
- Oura (readiness + HRV stress signals)
- Apple Health (Mindful Minutes)
- LLM journal analysis (with consent)

## How to see them

- Admin: **Agents Registry** page (`/admin` → Agents). Filter by tier
  = `embedded` and role = `pillar-scoring` to see all five.
- User: **Index Detail Screen** (`/health/vitana-index`) — a small
  "Active agents" panel shows which pillars are being watched and
  which integrations are currently connected for your account.

## Connecting an integration (future)

When you link a supported third-party app (e.g., Apple Health), the
corresponding pillar agent begins to read that data source and its
`connected_data` sub-score on that pillar fills in. You grant access
per integration, per agent — nothing happens without your opt-in.

## Why agents, not one big engine

Splitting the work into five specialised agents has three effects:

1. **Honest per-pillar signals.** The Exercise agent doesn't try to
   also score Sleep. Each pillar's data world is distinct; the model
   that serves one pillar well is not automatically right for another.
2. **Independent evolution.** The Nutrition agent can ship an LLM
   meal-photo parser without touching the Sleep or Mental agents.
   Third-party integrations land as small, safe drops per agent.
3. **Clear responsibility when something breaks.** If your Exercise
   score isn't moving, one agent is the place to look — not a
   monolithic compute engine.

The Vitana Index is the integration of five agents, not a single
mind. That matches how real health works.
$CONTENT$
);

COMMIT;
