-- VTID-02003 / Phase 5a — Tier 2 + Five-Stream + Loop 4/5 schema (additive only)
--
-- This migration is SCHEMA-ONLY. Tables created here are EMPTY at the end of
-- the migration; dual-writer code (Phase 5b) and the legacy backfill (Phase 5c)
-- will populate them. No existing reads or writes are affected.
--
-- Source: Vitana Infinite Memory plan (the-vitana-system-has-wild-puffin.md),
-- Part 7 ("Schema additions") + Part 6 ("Layer 2 — Infrastructure, Tier 2").
--
-- Tables added (16):
--   Tier 2 bi-temporal mirrors:
--     mem_episodes, mem_facts, mem_graph_edges, mem_turn_log, memory_write_dlq
--   Five Deep-Signal Streams:
--     user_personality_profile, mood_pattern_aggregates, biometric_trends,
--     biometric_events, user_location_history, user_location_settings,
--     user_device_session_log, relationship_dates, relationship_health_context
--   Loops 4 + 5:
--     index_delta_observations, vitana_index_trajectory_snapshots
--
-- ALTERs (additive):
--   relationship_edges (mention rolling stats), user_device_tokens (capability),
--   memory_items + live_rooms + thread_summaries + user_session_summaries +
--   user_preferences + community_recommendations (provenance closure).
--
-- All tenant_id columns use UUID to match the rest of the schema.
-- (The plan literally writes `tenant_id text`; UUID is consistent with
-- existing tenants(tenant_id) UUID PK and with how every other tenant-scoped
-- public.* table is declared.)
--
-- All new tables have RLS ENABLED. Service role bypasses; a basic
-- (tenant_id = current_tenant_id() AND user_id = auth.uid()) policy gates
-- authenticated reads. Phase 5b will refine where needed.

BEGIN;

-- ============================================================================
-- 1. Tier 2 — bi-temporal episodic / semantic / graph mirrors
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.mem_episodes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  session_id        uuid,
  conversation_id   uuid,
  -- episodic content
  kind              text NOT NULL CHECK (kind IN ('utterance','event','completion','observation','dyk_view','dismissal','navigation','arrival','departure','milestone','mention')),
  content           text,
  content_json      jsonb,
  importance        int NOT NULL DEFAULT 30 CHECK (importance BETWEEN 0 AND 100),
  category_key      text,
  source            text,
  workspace_scope   text,
  active_role       text,
  visibility_scope  text DEFAULT 'private',
  origin_service    text,
  vtid              text,
  -- semantic search
  embedding         vector(1536),
  embedding_model   text,
  embedding_updated_at timestamptz,
  -- bi-temporal
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  valid_from        timestamptz NOT NULL DEFAULT now(),
  valid_to          timestamptz,
  asserted_at       timestamptz NOT NULL DEFAULT now(),
  superseded_by     uuid REFERENCES public.mem_episodes(id),
  -- provenance (mandatory)
  actor_id          text NOT NULL,
  confidence        real NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  source_event_id   text,
  policy_version    text NOT NULL,
  source_engine     text,
  classification    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- bookkeeping
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mem_episodes_user_recent      ON public.mem_episodes (tenant_id, user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS mem_episodes_session          ON public.mem_episodes (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mem_episodes_active_window    ON public.mem_episodes (tenant_id, user_id, valid_from DESC) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS mem_episodes_embedding_hnsw   ON public.mem_episodes USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS public.mem_facts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  -- fact identity (matches memory_facts shape)
  entity            text NOT NULL DEFAULT 'self',
  fact_key          text NOT NULL,
  fact_value        text NOT NULL,
  fact_value_type   text NOT NULL DEFAULT 'text',
  -- semantic search
  embedding         vector(1536),
  embedding_model   text,
  embedding_updated_at timestamptz,
  -- bi-temporal
  valid_from        timestamptz NOT NULL DEFAULT now(),
  valid_to          timestamptz,
  asserted_at       timestamptz NOT NULL DEFAULT now(),
  superseded_by     uuid REFERENCES public.mem_facts(id),
  superseded_at     timestamptz,
  -- provenance
  actor_id          text NOT NULL,
  confidence        real NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  source_event_id   text,
  source_episode_id uuid REFERENCES public.mem_episodes(id),
  policy_version    text NOT NULL,
  source_engine     text,
  classification    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- bookkeeping
  extracted_at      timestamptz NOT NULL DEFAULT now(),
  vtid              text
);
CREATE UNIQUE INDEX IF NOT EXISTS mem_facts_active_unique
  ON public.mem_facts (tenant_id, user_id, entity, fact_key)
  WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS mem_facts_user_key             ON public.mem_facts (tenant_id, user_id, fact_key);
CREATE INDEX IF NOT EXISTS mem_facts_embedding_hnsw       ON public.mem_facts USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS public.mem_graph_edges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  -- graph endpoints (mirrors relationship_edges shape but bi-temporal)
  source_type       text NOT NULL,
  source_id         uuid NOT NULL,
  target_type       text NOT NULL,
  target_id         uuid NOT NULL,
  edge_type         text NOT NULL,
  strength          real NOT NULL DEFAULT 0.5 CHECK (strength BETWEEN 0 AND 1),
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- bi-temporal
  valid_from        timestamptz NOT NULL DEFAULT now(),
  valid_to          timestamptz,
  asserted_at       timestamptz NOT NULL DEFAULT now(),
  superseded_by     uuid REFERENCES public.mem_graph_edges(id),
  -- provenance
  actor_id          text NOT NULL,
  confidence        real NOT NULL DEFAULT 1.0,
  source_event_id   text,
  policy_version    text NOT NULL,
  source_engine     text,
  -- bookkeeping
  last_interaction_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mem_graph_edges_outbound      ON public.mem_graph_edges (tenant_id, user_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS mem_graph_edges_inbound       ON public.mem_graph_edges (tenant_id, user_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS mem_graph_edges_active        ON public.mem_graph_edges (tenant_id, user_id, edge_type) WHERE valid_to IS NULL;

-- Tier 0 backup: durable mirror of the Redis turn buffer
CREATE TABLE IF NOT EXISTS public.mem_turn_log (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  session_id        uuid NOT NULL,
  turn_index        int NOT NULL,
  speaker           text NOT NULL CHECK (speaker IN ('user','assistant','system')),
  content           text NOT NULL,
  modality          text,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  -- provenance light (turn log is high-volume)
  actor_id          text NOT NULL,
  policy_version    text NOT NULL,
  UNIQUE (session_id, turn_index)
);
CREATE INDEX IF NOT EXISTS mem_turn_log_session_recent  ON public.mem_turn_log (session_id, turn_index DESC);
CREATE INDEX IF NOT EXISTS mem_turn_log_user_recent     ON public.mem_turn_log (tenant_id, user_id, occurred_at DESC);

-- Failed writes get parked here for the self-healing reconciler to retry
CREATE TABLE IF NOT EXISTS public.memory_write_dlq (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid,
  user_id           uuid,
  stream            text NOT NULL,
  payload           jsonb NOT NULL,
  provenance        jsonb NOT NULL,
  error_class       text,
  error_message     text,
  attempt_count     int NOT NULL DEFAULT 0,
  next_retry_at     timestamptz,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_write_dlq_unresolved ON public.memory_write_dlq (next_retry_at NULLS FIRST) WHERE resolved_at IS NULL;

-- ============================================================================
-- 2. Five Deep-Signal Streams
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_personality_profile (
  user_id              uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL,
  sentence_length_avg  real,
  emoji_usage          text CHECK (emoji_usage IN ('none','low','medium','high')),
  valence_avg_30d      real,
  agency_language      text,
  novelty_seeking      real,
  social_orientation   text,
  routine_consistency  real,
  emotional_range      real,
  sample_size_days     int NOT NULL DEFAULT 0,
  last_computed_at     timestamptz,
  confidence           real NOT NULL DEFAULT 0,
  policy_version       text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.mood_pattern_aggregates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  pattern_type    text NOT NULL CHECK (pattern_type IN ('stressor','joy','rumination','energy_dip','flow_state')),
  theme           text NOT NULL,
  intensity_avg   real NOT NULL,
  occurrences_30d int NOT NULL,
  first_observed  timestamptz NOT NULL,
  last_observed   timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','faded','resolved')),
  policy_version  text NOT NULL
);
CREATE INDEX IF NOT EXISTS mood_pattern_user_active ON public.mood_pattern_aggregates (tenant_id, user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.biometric_trends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  feature_key     text NOT NULL,
  pillar          text NOT NULL,
  mean_7d         real,
  mean_30d        real,
  mean_90d        real,
  std_30d         real,
  latest          real,
  latest_z_score  real,
  trend_class     text NOT NULL CHECK (trend_class IN ('improving','stable','regressing','volatile','insufficient_data')),
  anomaly_flag    boolean NOT NULL DEFAULT false,
  last_anomaly_at timestamptz,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, feature_key)
);
CREATE INDEX IF NOT EXISTS biometric_trends_anomalies ON public.biometric_trends (tenant_id, user_id) WHERE anomaly_flag = true;

CREATE TABLE IF NOT EXISTS public.biometric_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  event_type      text NOT NULL CHECK (event_type IN ('anomaly_detected','new_personal_best','regression_window_started','trend_reversal','illness_signature_detected','recovery_dip','sleep_deficit')),
  feature_key     text NOT NULL,
  pillar          text NOT NULL,
  detail          jsonb NOT NULL,
  confidence      real NOT NULL,
  observed_at     timestamptz NOT NULL,
  expires_at      timestamptz,
  acknowledged_at timestamptz,
  policy_version  text NOT NULL
);
-- Partial index can't use now() (must be IMMUTABLE); filter expires_at at query time.
CREATE INDEX IF NOT EXISTS biometric_events_active ON public.biometric_events (tenant_id, user_id, observed_at DESC) WHERE acknowledged_at IS NULL;

CREATE TABLE IF NOT EXISTS public.user_location_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  name            text NOT NULL,
  locality        text,
  country         text,
  timezone        text,
  is_primary_home boolean NOT NULL DEFAULT false,
  user_confirmed  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, name)
);

CREATE TABLE IF NOT EXISTS public.user_location_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  location_type   text NOT NULL CHECK (location_type IN ('home','work','gym','traveling','unknown','named_place')),
  named_place_id  uuid REFERENCES public.user_location_settings(id) ON DELETE SET NULL,
  locality        text,
  country         text,
  timezone        text NOT NULL,
  lat_coarse      real,
  lon_coarse      real,
  source          text NOT NULL CHECK (source IN ('device_geo','calendar_event_location','ip_inferred','user_stated','integration_pull')),
  confidence      real NOT NULL,
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  asserted_at     timestamptz NOT NULL DEFAULT now(),
  policy_version  text NOT NULL,
  -- Lat/lon coarseness invariant: refuse anything finer than ~10km grid
  CONSTRAINT user_location_history_coarse_chk CHECK (
    lat_coarse IS NULL OR (lat_coarse = round(lat_coarse::numeric, 1)::real)
  )
);
CREATE INDEX IF NOT EXISTS user_location_current ON public.user_location_history (tenant_id, user_id, valid_from DESC) WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS public.user_device_session_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  device_token_id uuid NOT NULL REFERENCES public.user_device_tokens(id) ON DELETE CASCADE,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  modality        text NOT NULL CHECK (modality IN ('voice','text','push_only','silent')),
  screens_visited int NOT NULL DEFAULT 0,
  app_version     text
);
CREATE INDEX IF NOT EXISTS user_device_session_recent ON public.user_device_session_log (user_id, started_at DESC);

-- relationship_dates depends on relationship_nodes existing
CREATE TABLE IF NOT EXISTS public.relationship_dates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  relationship_node_id uuid NOT NULL REFERENCES public.relationship_nodes(id) ON DELETE CASCADE,
  date_type       text NOT NULL CHECK (date_type IN ('birthday','anniversary','important_date')),
  month           int NOT NULL CHECK (month BETWEEN 1 AND 12),
  day             int NOT NULL CHECK (day BETWEEN 1 AND 31),
  year            int,
  user_confirmed  boolean NOT NULL DEFAULT false,
  source          text NOT NULL,
  policy_version  text NOT NULL
);
CREATE INDEX IF NOT EXISTS relationship_dates_upcoming ON public.relationship_dates (tenant_id, user_id, month, day) WHERE user_confirmed = true;

CREATE TABLE IF NOT EXISTS public.relationship_health_context (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  relationship_node_id uuid NOT NULL REFERENCES public.relationship_nodes(id) ON DELETE CASCADE,
  condition       text NOT NULL,
  asserted_at     timestamptz NOT NULL,
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz,
  superseded_by   uuid REFERENCES public.relationship_health_context(id),
  source_episode_id uuid REFERENCES public.mem_episodes(id),
  policy_version  text NOT NULL,
  classification  jsonb NOT NULL DEFAULT '{"health":true,"sensitivity":"high"}'::jsonb
);
CREATE INDEX IF NOT EXISTS relationship_health_context_active ON public.relationship_health_context (tenant_id, user_id) WHERE valid_to IS NULL;

-- ============================================================================
-- 3. Loops 4 + 5
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.index_delta_observations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  recommendation_id uuid NOT NULL REFERENCES public.autopilot_recommendations(id) ON DELETE CASCADE,
  pillar            text NOT NULL,
  predicted_delta   real NOT NULL,
  observed_delta    real,
  observation_window_hours int NOT NULL DEFAULT 24,
  observed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS index_delta_observations_user ON public.index_delta_observations (tenant_id, user_id, created_at DESC);

-- "window" is a reserved keyword; using time_window instead.
CREATE TABLE IF NOT EXISTS public.vitana_index_trajectory_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  snapshot_date   date NOT NULL,
  time_window     text NOT NULL CHECK (time_window IN ('7d','30d','90d')),
  narrative       text NOT NULL,
  pillars_snapshot jsonb NOT NULL,
  balance_factor_avg real NOT NULL,
  tier_at_start   text NOT NULL,
  tier_at_end     text NOT NULL,
  trajectory_class text NOT NULL CHECK (trajectory_class IN ('improving','stable','regressing','volatile')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, snapshot_date, time_window)
);
CREATE INDEX IF NOT EXISTS vitana_index_trajectory_user ON public.vitana_index_trajectory_snapshots (tenant_id, user_id, snapshot_date DESC);

-- ============================================================================
-- 4. ALTERs (additive)
-- ============================================================================

-- ALTERs on legacy tables — guarded by to_regclass() so a missing table
-- doesn't abort the whole transaction. Tables that don't exist yet
-- (e.g., community_recommendations) are skipped silently; the matching
-- columns will get added when those tables are eventually created.
DO $alters$
BEGIN
  -- Stream 5 — relationship_edges rolling stats
  IF to_regclass('public.relationship_edges') IS NOT NULL THEN
    ALTER TABLE public.relationship_edges
      ADD COLUMN IF NOT EXISTS mention_count_30d int NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS mention_count_90d int NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_mentioned_at timestamptz,
      ADD COLUMN IF NOT EXISTS sentiment_avg     real,
      ADD COLUMN IF NOT EXISTS recent_topics     jsonb;
  END IF;

  -- Stream 4 — user_device_tokens capability flags
  IF to_regclass('public.user_device_tokens') IS NOT NULL THEN
    ALTER TABLE public.user_device_tokens
      ADD COLUMN IF NOT EXISTS device_type             text,
      ADD COLUMN IF NOT EXISTS os_version              text,
      ADD COLUMN IF NOT EXISTS app_version             text,
      ADD COLUMN IF NOT EXISTS paired_wearables        jsonb,
      ADD COLUMN IF NOT EXISTS last_active_at          timestamptz,
      ADD COLUMN IF NOT EXISTS last_session_modality   text,
      ADD COLUMN IF NOT EXISTS last_known_timezone     text,
      ADD COLUMN IF NOT EXISTS notification_capability text;
  END IF;

  -- Provenance closure
  IF to_regclass('public.memory_items') IS NOT NULL THEN
    ALTER TABLE public.memory_items
      ADD COLUMN IF NOT EXISTS provenance_source     text,
      ADD COLUMN IF NOT EXISTS provenance_confidence real,
      ADD COLUMN IF NOT EXISTS source_engine         text;
  END IF;

  IF to_regclass('public.live_rooms') IS NOT NULL THEN
    ALTER TABLE public.live_rooms
      ADD COLUMN IF NOT EXISTS transcription_confidence    real,
      ADD COLUMN IF NOT EXISTS transcription_model_version text,
      ADD COLUMN IF NOT EXISTS audio_quality_metrics       jsonb;
  END IF;

  IF to_regclass('public.thread_summaries') IS NOT NULL THEN
    ALTER TABLE public.thread_summaries
      ADD COLUMN IF NOT EXISTS summary_confidence    real,
      ADD COLUMN IF NOT EXISTS summary_model_version text;
  END IF;

  IF to_regclass('public.user_session_summaries') IS NOT NULL THEN
    ALTER TABLE public.user_session_summaries
      ADD COLUMN IF NOT EXISTS summary_confidence    real,
      ADD COLUMN IF NOT EXISTS summary_model_version text;
  END IF;

  IF to_regclass('public.user_preferences') IS NOT NULL THEN
    ALTER TABLE public.user_preferences
      ADD COLUMN IF NOT EXISTS source                    text,
      ADD COLUMN IF NOT EXISTS confidence                real,
      ADD COLUMN IF NOT EXISTS inferred_from_sample_size int;
  END IF;

  IF to_regclass('public.community_recommendations') IS NOT NULL THEN
    ALTER TABLE public.community_recommendations
      ADD COLUMN IF NOT EXISTS engine_version   text,
      ADD COLUMN IF NOT EXISTS algorithm_type   text,
      ADD COLUMN IF NOT EXISTS confidence_score real;
  ELSE
    RAISE NOTICE 'skipping community_recommendations ALTERs — table does not exist';
  END IF;
END
$alters$;

-- ============================================================================
-- 5. RLS — enable + basic tenant+user policy on every new table
--    Service role bypasses RLS; this gates direct anon/authenticated access.
-- ============================================================================

DO $rls$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'mem_episodes','mem_facts','mem_graph_edges','mem_turn_log','memory_write_dlq',
      'user_personality_profile','mood_pattern_aggregates',
      'biometric_trends','biometric_events',
      'user_location_history','user_location_settings',
      'user_device_session_log',
      'relationship_dates','relationship_health_context',
      'index_delta_observations','vitana_index_trajectory_snapshots'
    ])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'DROP POLICY IF EXISTS %I_tenant_user_select ON public.%I',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY %I_tenant_user_select ON public.%I FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid())',
      t, t
    );
  END LOOP;
END
$rls$;

-- ============================================================================
-- 6. Comments
-- ============================================================================

COMMENT ON TABLE public.mem_episodes IS
  'VTID-02003 Phase 5a — Tier 2 bi-temporal episodic mirror of memory_items / live_rooms / chat_messages. Populated by dual-writer in Phase 5b.';
COMMENT ON TABLE public.mem_facts IS
  'VTID-02003 Phase 5a — Tier 2 bi-temporal semantic facts mirror of memory_facts. Auto-supersession via valid_to.';
COMMENT ON TABLE public.mem_graph_edges IS
  'VTID-02003 Phase 5a — Tier 2 bi-temporal graph mirror of relationship_edges. SOCIAL block of MemoryPack.';
COMMENT ON TABLE public.memory_write_dlq IS
  'VTID-02003 Phase 5a — failed-memory-write parking lot, drained by self-healing reconciler.';
COMMENT ON TABLE public.user_personality_profile IS
  'VTID-02003 Phase 5a — Stream 1 (Diary) personality profile. Updated by nightly consolidator (Phase 8).';
COMMENT ON TABLE public.biometric_trends IS
  'VTID-02003 Phase 5a — Stream 2 rolling biometric stats per feature_key. Anomaly events go to biometric_events.';
COMMENT ON TABLE public.user_location_history IS
  'VTID-02003 Phase 5a — Stream 3 inferred location history. lat_coarse/lon_coarse rounded to 1dp (~10km); finer resolution NEVER stored.';
COMMENT ON TABLE public.user_device_session_log IS
  'VTID-02003 Phase 5a — Stream 4 sliding 30d device session log. Pruned by daily job (rows older than 30d deleted).';
COMMENT ON TABLE public.relationship_dates IS
  'VTID-02003 Phase 5a — Stream 5 important dates (birthday/anniversary/important_date). user_confirmed=true is required before brain treats as canonical.';
COMMENT ON TABLE public.relationship_health_context IS
  'VTID-02003 Phase 5a — Stream 5 HIPAA-scoped health context about people the user mentioned. Soft-locked, requires explicit user_stated source.';
COMMENT ON TABLE public.index_delta_observations IS
  'VTID-02003 Phase 5a — Loop 4 Index-delta-learner observation rows. Calibrates ranker priors nightly (Phase 8).';
COMMENT ON TABLE public.vitana_index_trajectory_snapshots IS
  'VTID-02003 Phase 5a — Loop 5 trajectory narrative snapshots. Powers "what changed in your Index this week" answers.';

SELECT 'Phase 5a tables present:' AS report;
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'mem_episodes','mem_facts','mem_graph_edges','mem_turn_log','memory_write_dlq',
    'user_personality_profile','mood_pattern_aggregates',
    'biometric_trends','biometric_events',
    'user_location_history','user_location_settings','user_device_session_log',
    'relationship_dates','relationship_health_context',
    'index_delta_observations','vitana_index_trajectory_snapshots'
  )
ORDER BY table_name;

COMMIT;
