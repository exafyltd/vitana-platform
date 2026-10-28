-- =============================================================================
-- VTID-02690: Seed orb-agent in agents_registry + agent_voice_configs (Google cascade)
-- =============================================================================
-- The orb-agent's heartbeat self-registration was failing earlier because
-- GATEWAY_SERVICE_TOKEN was empty during the smoke-test deploy, so the
-- agents_registry row never landed and the conditional seed in PR #1156
-- couldn't insert the voice config row either.
--
-- This migration:
--   1. Inserts the agents_registry row for orb-agent (idempotent).
--   2. Upserts the agent_voice_configs row pointing to the all-Google cascade:
--        STT: google_stt / latest_long
--        LLM: google_llm / gemini-3.1-flash-lite-preview
--        TTS: google_tts / en-US-Chirp3-HD-Aoede
--      All three use Application Default Credentials — no third-party API
--      keys needed; the Cloud Run service account inherits the project's
--      Vertex / Speech-to-Text / Text-to-Speech access.
-- =============================================================================

BEGIN;

-- 1. agents_registry row
INSERT INTO agents_registry
  (agent_id, display_name, description, tier, role, llm_provider, llm_model, source_path, health_endpoint, metadata)
VALUES
  ('orb-agent',
   'ORB LiveKit Agent',
   'LiveKit-based ORB voice agent worker. Standby alternative to the Vertex Live pipeline (services/gateway/src/routes/orb-live.ts). Joins LiveKit rooms as a participant and runs a configurable STT/LLM/TTS cascade.',
   'service', 'voice', 'gemini', 'gemini-3.1-flash-lite-preview',
   'services/agents/orb-agent/', '/health',
   jsonb_build_object('language', 'python', 'framework', 'livekit-agents', 'vtid', 'VTID-LIVEKIT-FOUNDATION'))
ON CONFLICT (agent_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  source_path = EXCLUDED.source_path,
  metadata = EXCLUDED.metadata;

-- 2. agent_voice_configs row — all-Google cascade
INSERT INTO agent_voice_configs (
  agent_id, transport,
  stt_provider, stt_model, stt_options,
  llm_provider, llm_model, llm_options,
  tts_provider, tts_model, tts_options
) VALUES (
  'orb-agent', 'livekit_cascade',
  'google_stt',  'latest_long',                      jsonb_build_object('languages', ARRAY['en-US']),
  'google_llm',  'gemini-3.1-flash-lite-preview',           jsonb_build_object('temperature', 0.7),
  'google_tts',  'en-US-Chirp3-HD-Aoede',            jsonb_build_object('language_code', 'en-US')
) ON CONFLICT (agent_id) DO UPDATE SET
  transport     = EXCLUDED.transport,
  stt_provider  = EXCLUDED.stt_provider,
  stt_model     = EXCLUDED.stt_model,
  stt_options   = EXCLUDED.stt_options,
  llm_provider  = EXCLUDED.llm_provider,
  llm_model     = EXCLUDED.llm_model,
  llm_options   = EXCLUDED.llm_options,
  tts_provider  = EXCLUDED.tts_provider,
  tts_model     = EXCLUDED.tts_model,
  tts_options   = EXCLUDED.tts_options;

COMMIT;
