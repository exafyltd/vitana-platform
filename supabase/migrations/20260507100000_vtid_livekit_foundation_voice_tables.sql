-- =============================================================================
-- VTID-LIVEKIT-FOUNDATION: voice provider registry + per-agent voice config
-- =============================================================================
-- Adds the data model that the LiveKit standby pipeline depends on:
--
--   voice_providers              system-managed catalogue of every supported
--                                STT/LLM/TTS/transport vendor + models
--   agent_voice_configs          one row per agent in agents_registry —
--                                operator-edited via Command Hub Voice Lab
--   agent_voice_config_changes   audit trail
--   voice_active_provider_changes  audit trail of global-switch flips
--   voice_canary_baselines       snapshot for synthetic-canary diffs
--   voice_parity_drifts          parity-scanner output rows visible in Voice Lab
--
-- The active-provider switch (vertex|livekit) lives in system_config (or
-- env var VOICE_ACTIVE_PROVIDER until system_config is generalised). This
-- migration assumes system_config exists; if not, we fall back to env var
-- and a noop bootstrap row here. NEVER hard-codes the LiveKit Cloud URL —
-- self-hosted is the deployment target per the approved plan.
--
-- See .claude/plans/here-is-what-our-valiant-stearns.md for the full design.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- voice_providers — system-managed catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS voice_providers (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('stt', 'llm', 'tts', 'transport')),
  display_name    TEXT NOT NULL,
  models          JSONB NOT NULL DEFAULT '[]'::jsonb,
  options_schema  JSONB NOT NULL DEFAULT '{}'::jsonb,
  plugin_module   TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  fallback_chain  TEXT[],
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_providers_kind ON voice_providers(kind);
CREATE INDEX IF NOT EXISTS idx_voice_providers_enabled ON voice_providers(enabled);

-- ---------------------------------------------------------------------------
-- agent_voice_configs — per-agent provider trio
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_voice_configs (
  agent_id      TEXT PRIMARY KEY REFERENCES agents_registry(agent_id) ON DELETE CASCADE,
  transport     TEXT NOT NULL DEFAULT 'livekit_cascade'
                CHECK (transport IN ('vertex','livekit_cascade','livekit_half_cascade','livekit_realtime')),
  stt_provider  TEXT REFERENCES voice_providers(id),
  stt_model     TEXT,
  stt_options   JSONB NOT NULL DEFAULT '{}'::jsonb,
  llm_provider  TEXT REFERENCES voice_providers(id),
  llm_model     TEXT,
  llm_options   JSONB NOT NULL DEFAULT '{}'::jsonb,
  tts_provider  TEXT REFERENCES voice_providers(id),
  tts_model     TEXT,
  tts_options   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    UUID
);

CREATE INDEX IF NOT EXISTS idx_agent_voice_configs_transport ON agent_voice_configs(transport);

-- ---------------------------------------------------------------------------
-- agent_voice_config_changes — audit trail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_voice_config_changes (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    TEXT REFERENCES agents_registry(agent_id) ON DELETE CASCADE,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by  UUID,
  reason      TEXT,
  before      JSONB,
  after       JSONB
);

CREATE INDEX IF NOT EXISTS idx_agent_voice_config_changes_agent_at
  ON agent_voice_config_changes(agent_id, changed_at DESC);

-- ---------------------------------------------------------------------------
-- voice_active_provider_changes — audit trail for the global switch
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS voice_active_provider_changes (
  id              BIGSERIAL PRIMARY KEY,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by      UUID,
  from_provider   TEXT NOT NULL,
  to_provider     TEXT NOT NULL,
  reason          TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_voice_active_provider_changes_at
  ON voice_active_provider_changes(changed_at DESC);

-- ---------------------------------------------------------------------------
-- voice_canary_baselines — synthetic-canary snapshot
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS voice_canary_baselines (
  id              BIGSERIAL PRIMARY KEY,
  pipeline        TEXT NOT NULL CHECK (pipeline IN ('vertex','livekit')),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  utterances      JSONB NOT NULL,
  expected_tools  JSONB NOT NULL,
  expected_topics JSONB NOT NULL,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_voice_canary_baselines_pipeline_at
  ON voice_canary_baselines(pipeline, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- voice_parity_drifts — parity-scanner output, rendered in Voice Lab
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS voice_parity_drifts (
  id              BIGSERIAL PRIMARY KEY,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pr_number       INTEGER,
  category        TEXT NOT NULL CHECK (category IN (
                    'missing_in_vertex','missing_in_livekit',
                    'value_mismatch','undeclared',
                    'signature_mismatch','static_runtime_drift'
                  )),
  kind            TEXT NOT NULL CHECK (kind IN ('tool','oasis_topic','watchdog','system_instruction')),
  name            TEXT NOT NULL,
  detail          TEXT,
  severity        TEXT NOT NULL CHECK (severity IN ('safety_critical','high','low')),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_voice_parity_drifts_open
  ON voice_parity_drifts(detected_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_voice_parity_drifts_severity
  ON voice_parity_drifts(severity, detected_at DESC) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION voice_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_voice_providers_updated_at ON voice_providers;
CREATE TRIGGER trg_voice_providers_updated_at
  BEFORE UPDATE ON voice_providers FOR EACH ROW EXECUTE FUNCTION voice_set_updated_at();

DROP TRIGGER IF EXISTS trg_agent_voice_configs_updated_at ON agent_voice_configs;
CREATE TRIGGER trg_agent_voice_configs_updated_at
  BEFORE UPDATE ON agent_voice_configs FOR EACH ROW EXECUTE FUNCTION voice_set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit trigger on agent_voice_configs — every UPDATE writes a change row
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION agent_voice_configs_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO agent_voice_config_changes (agent_id, changed_by, reason, before, after)
    VALUES (
      NEW.agent_id,
      NEW.updated_by,
      'manual',
      to_jsonb(OLD),
      to_jsonb(NEW)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_voice_configs_audit ON agent_voice_configs;
CREATE TRIGGER trg_agent_voice_configs_audit
  AFTER UPDATE ON agent_voice_configs FOR EACH ROW EXECUTE FUNCTION agent_voice_configs_audit();

-- ---------------------------------------------------------------------------
-- RLS — service-role only (matches agents_registry pattern)
-- ---------------------------------------------------------------------------

ALTER TABLE voice_providers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to voice_providers" ON voice_providers;
CREATE POLICY "Service role full access to voice_providers"
  ON voice_providers FOR ALL USING (auth.role() = 'service_role');
GRANT ALL ON voice_providers TO service_role;

ALTER TABLE agent_voice_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to agent_voice_configs" ON agent_voice_configs;
CREATE POLICY "Service role full access to agent_voice_configs"
  ON agent_voice_configs FOR ALL USING (auth.role() = 'service_role');
GRANT ALL ON agent_voice_configs TO service_role;

ALTER TABLE agent_voice_config_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to agent_voice_config_changes" ON agent_voice_config_changes;
CREATE POLICY "Service role full access to agent_voice_config_changes"
  ON agent_voice_config_changes FOR ALL USING (auth.role() = 'service_role');
GRANT ALL ON agent_voice_config_changes TO service_role;

ALTER TABLE voice_active_provider_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to voice_active_provider_changes" ON voice_active_provider_changes;
CREATE POLICY "Service role full access to voice_active_provider_changes"
  ON voice_active_provider_changes FOR ALL USING (auth.role() = 'service_role');
GRANT ALL ON voice_active_provider_changes TO service_role;

ALTER TABLE voice_canary_baselines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to voice_canary_baselines" ON voice_canary_baselines;
CREATE POLICY "Service role full access to voice_canary_baselines"
  ON voice_canary_baselines FOR ALL USING (auth.role() = 'service_role');
GRANT ALL ON voice_canary_baselines TO service_role;

ALTER TABLE voice_parity_drifts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to voice_parity_drifts" ON voice_parity_drifts;
CREATE POLICY "Service role full access to voice_parity_drifts"
  ON voice_parity_drifts FOR ALL USING (auth.role() = 'service_role');
GRANT ALL ON voice_parity_drifts TO service_role;

-- ---------------------------------------------------------------------------
-- Seed: voice_providers catalogue
-- ---------------------------------------------------------------------------

INSERT INTO voice_providers (id, kind, display_name, models, options_schema, plugin_module, fallback_chain, notes) VALUES
-- transports
('vertex',                 'transport', 'Vertex AI Gemini Live',
   '[{"id":"gemini-live-2.5-flash-native-audio","display_name":"Gemini Live 2.5 Flash (native audio)","streaming":true}]'::jsonb,
   '{}'::jsonb, NULL, NULL,
   'Existing pipeline, kept tier-1 standby. Self-hosted LiveKit is the new default once activated.'),
('livekit_cascade',        'transport', 'LiveKit (full cascade)',
   '[]'::jsonb, '{}'::jsonb, NULL, NULL,
   'Self-hosted LiveKit OSS on GCP Compute Engine. Picks STT + LLM + TTS independently.'),
('livekit_half_cascade',   'transport', 'LiveKit (half-cascade)',
   '[]'::jsonb, '{}'::jsonb, NULL, NULL,
   'Realtime STT+LLM (e.g. OpenAI Realtime) + separate TTS. Available but not default.'),
('livekit_realtime',       'transport', 'LiveKit (realtime model)',
   '[{"id":"openai-realtime","display_name":"OpenAI Realtime"},{"id":"gemini-live","display_name":"Gemini Live (via LiveKit)"}]'::jsonb,
   '{}'::jsonb, NULL, NULL,
   'Single-vendor monolithic model, wrapped by LiveKit transport.'),

-- STT providers
('deepgram',     'stt', 'Deepgram',
   '[{"id":"nova-3","display_name":"Nova 3 (default)","streaming":true},{"id":"nova-2-general","display_name":"Nova 2 General","streaming":true},{"id":"nova-2-meeting","display_name":"Nova 2 Meeting","streaming":true}]'::jsonb,
   '{"interim_results":{"type":"boolean","default":true},"diarize":{"type":"boolean","default":false}}'::jsonb,
   'livekit.plugins.deepgram', ARRAY['assemblyai','google_stt'], NULL),
('assemblyai',   'stt', 'AssemblyAI',
   '[{"id":"universal-streaming","display_name":"Universal Streaming","streaming":true},{"id":"u3-rt-pro","display_name":"U3 RT Pro","streaming":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.assemblyai', ARRAY['deepgram','google_stt'],
   'Auto-scales; comfortable at our concurrency.'),
('google_stt',   'stt', 'Google Cloud STT',
   '[{"id":"latest_long","display_name":"Latest Long","streaming":true},{"id":"chirp_2","display_name":"Chirp 2","streaming":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.google', ARRAY['deepgram','assemblyai'], NULL),
('cartesia_stt', 'stt', 'Cartesia STT',
   '[{"id":"ink-whisper","display_name":"Ink Whisper","streaming":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.cartesia', NULL,
   'verified: false — empirical Phase 0 test pending.'),
('soniox',       'stt', 'Soniox',
   '[{"id":"stt-rt-v4","display_name":"STT RT v4","streaming":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.soniox', NULL, NULL),
('speechmatics', 'stt', 'Speechmatics',
   '[{"id":"enhanced-streaming","display_name":"Enhanced Streaming","streaming":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.speechmatics', NULL, NULL),
('groq_stt',     'stt', 'Groq Whisper',
   '[{"id":"whisper-large-v3-turbo","display_name":"Whisper Large v3 Turbo","streaming":false}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.groq', NULL,
   'verified: false — empirical Phase 0 test pending.'),
('azure_stt',    'stt', 'Azure Speech',
   '[{"id":"en-US-JennyMultilingualNeural","streaming":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.azure', NULL, NULL),
('openai_stt',   'stt', 'OpenAI (Whisper / Realtime)',
   '[{"id":"gpt-4o-mini-transcribe","display_name":"GPT-4o-mini transcribe","streaming":true},{"id":"whisper-1","display_name":"Whisper 1 (legacy, non-streaming)","streaming":false}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.openai', NULL, NULL),

-- LLM providers
('anthropic',    'llm', 'Anthropic Claude',
   '[{"id":"claude-sonnet-4-6","display_name":"Claude Sonnet 4.6 (default)","streaming":true,"tool_call":true},{"id":"claude-opus-4-7","display_name":"Claude Opus 4.7","streaming":true,"tool_call":true},{"id":"claude-haiku-4-5","display_name":"Claude Haiku 4.5","streaming":true,"tool_call":true}]'::jsonb,
   '{"temperature":{"type":"number","default":0.7,"min":0,"max":1},"max_tokens":{"type":"integer","default":4000}}'::jsonb,
   'livekit.plugins.anthropic', ARRAY['google_llm','openai'], NULL),
('openai',       'llm', 'OpenAI',
   '[{"id":"gpt-4o","display_name":"GPT-4o","streaming":true,"tool_call":true},{"id":"gpt-4o-mini","display_name":"GPT-4o mini","streaming":true,"tool_call":true},{"id":"gpt-4.1","display_name":"GPT-4.1","streaming":true,"tool_call":true}]'::jsonb,
   '{"temperature":{"type":"number","default":0.7}}'::jsonb,
   'livekit.plugins.openai', ARRAY['anthropic','google_llm'], NULL),
('google_llm',   'llm', 'Google Gemini',
   '[{"id":"gemini-2.5-flash","display_name":"Gemini 2.5 Flash","streaming":true,"tool_call":true},{"id":"gemini-2.5-pro","display_name":"Gemini 2.5 Pro","streaming":true,"tool_call":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.google', ARRAY['anthropic','openai'], NULL),
('xai',          'llm', 'xAI Grok',
   '[{"id":"grok-3","display_name":"Grok 3","streaming":true,"tool_call":true},{"id":"grok-4","display_name":"Grok 4","streaming":true,"tool_call":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.xai', NULL, NULL),
('mistral',      'llm', 'Mistral',
   '[{"id":"mistral-large","display_name":"Mistral Large","streaming":true,"tool_call":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.mistralai', NULL,
   'verified: false — empirical Phase 0 test pending.'),
('groq',         'llm', 'Groq',
   '[{"id":"llama-3.3-70b","display_name":"Llama 3.3 70B","streaming":true,"tool_call":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.groq', NULL, NULL),
('cerebras',     'llm', 'Cerebras',
   '[{"id":"llama3.1-70b","display_name":"Llama 3.1 70B","streaming":true,"tool_call":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.cerebras', NULL, NULL),

-- TTS providers
('elevenlabs',   'tts', 'ElevenLabs',
   '[{"id":"eleven_turbo_v2_5","display_name":"Turbo v2.5 (default)","streaming":true},{"id":"eleven_multilingual_v2","display_name":"Multilingual v2","streaming":true}]'::jsonb,
   '{"voice_id":{"type":"string"},"stability":{"type":"number","default":0.5},"similarity_boost":{"type":"number","default":0.5}}'::jsonb,
   'livekit.plugins.elevenlabs', ARRAY['cartesia','deepgram_tts'], NULL),
('cartesia',     'tts', 'Cartesia',
   '[{"id":"sonic-3","display_name":"Sonic 3 (default)","streaming":true},{"id":"sonic-multilingual","display_name":"Sonic Multilingual","streaming":true}]'::jsonb,
   '{"voice_id":{"type":"string"}}'::jsonb,
   'livekit.plugins.cartesia', ARRAY['deepgram_tts','google_tts'], NULL),
('rime',         'tts', 'Rime',
   '[{"id":"mistv2","display_name":"Mist v2","streaming":false},{"id":"arcana","display_name":"Arcana","streaming":false}]'::jsonb,
   '{"voice_id":{"type":"string"}}'::jsonb,
   'livekit.plugins.rime', NULL,
   'streaming=false on both models. Hidden by default in Voice Lab UI for the orb-live cascade.'),
('inworld',      'tts', 'Inworld',
   '[{"id":"inworld-tts-1","display_name":"Inworld TTS 1","streaming":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.inworld', NULL, NULL),
('deepgram_tts', 'tts', 'Deepgram Aura',
   '[{"id":"aura-2-andromeda-en","display_name":"Aura 2 Andromeda (default)","streaming":true},{"id":"aura-asteria-en","display_name":"Aura Asteria","streaming":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.deepgram', NULL, NULL),
('openai_tts',   'tts', 'OpenAI TTS',
   '[{"id":"tts-1","display_name":"TTS 1","streaming":false},{"id":"tts-1-hd","display_name":"TTS 1 HD","streaming":false},{"id":"gpt-4o-mini-tts","display_name":"GPT-4o-mini TTS","streaming":false}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.openai', NULL,
   'streaming=false. Hidden by default in Voice Lab UI.'),
('google_tts',   'tts', 'Google Cloud TTS',
   '[{"id":"gemini-2.5-flash-tts","display_name":"Gemini 2.5 Flash TTS","streaming":true},{"id":"en-US-Chirp3-HD-Aoede","display_name":"Chirp 3 HD Aoede","streaming":true}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.google', NULL, NULL),
('azure_tts',    'tts', 'Azure Speech TTS',
   '[{"id":"en-US-JennyNeural","display_name":"Jenny Neural","streaming":false}]'::jsonb,
   '{}'::jsonb, 'livekit.plugins.azure', NULL,
   'streaming=false. Hidden by default in Voice Lab UI.')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: agent_voice_configs row for the new orb-agent
-- (only inserted if the agent exists in agents_registry — the orb-agent
-- skeleton PR registers itself via heartbeat at runtime, so this row is
-- conditional)
-- ---------------------------------------------------------------------------

INSERT INTO agent_voice_configs (
  agent_id, transport,
  stt_provider, stt_model,
  llm_provider, llm_model,
  tts_provider, tts_model
)
SELECT
  'orb-agent', 'livekit_cascade',
  'deepgram',   'nova-3',
  'anthropic',  'claude-sonnet-4-6',
  'cartesia',   'sonic-3'
WHERE EXISTS (SELECT 1 FROM agents_registry WHERE agent_id = 'orb-agent')
ON CONFLICT (agent_id) DO NOTHING;

COMMIT;
