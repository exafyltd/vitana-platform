-- =============================================================================
-- VTID-03032: Devon agents_registry row + voice config (fixes VTID-03031 rollback)
-- =============================================================================
-- VTID-03031 attempted to INSERT into agent_voice_configs for agent_id='devon'
-- but rolled back with:
--   ERROR:  insert or update on table "agent_voice_configs" violates foreign
--   key constraint "agent_voice_configs_agent_id_fkey"
--
-- Root cause: agent_voice_configs.agent_id FK → agents_registry.agent_id. The
-- 4 personas (devon/sage/atlas/mira) live in agent_personas but were never
-- registered in agents_registry — they're personas, not separate worker
-- services. The FK design predates the persona system.
--
-- Fix: register Devon in agents_registry as tier='embedded' (he runs inside
-- the orb-agent process), then insert his voice config. Both inserts idempotent.
--
-- Voice spec: Chirp3-HD-Charon (MALE) for every supported language. Resolution
-- happens in _resolve_tts_voice() at providers.py via voices_per_lang.
-- =============================================================================

BEGIN;

-- 1. agents_registry row for Devon (embedded tier — runs inside orb-agent worker)
INSERT INTO agents_registry
  (agent_id, display_name, description, tier, role, llm_provider, llm_model, source_path, health_endpoint, metadata)
VALUES
  ('devon',
   'Devon (Tech Support)',
   'Specialist persona for technical bug-report intake. Embedded inside the orb-agent worker; activated via report_to_specialist tool call.',
   'embedded', 'specialist', 'gemini', 'gemini-2.5-flash',
   'services/agents/orb-agent/', NULL,
   jsonb_build_object('persona_key', 'devon', 'vtid', 'VTID-03032'))
ON CONFLICT (agent_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description  = EXCLUDED.description,
  source_path  = EXCLUDED.source_path,
  metadata     = EXCLUDED.metadata;

-- 2. agent_voice_configs row for Devon — male Chirp3-HD-Charon per language
INSERT INTO agent_voice_configs (
  agent_id, transport,
  stt_provider, stt_model, stt_options,
  llm_provider, llm_model, llm_options,
  tts_provider, tts_model, tts_options
) VALUES (
  'devon',
  'livekit_cascade',
  'google_stt',
  'latest_long',
  '{}'::jsonb,
  'google_llm',
  'gemini-2.5-flash',
  jsonb_build_object('temperature', 0.7),
  'google_tts',
  'en-US-Chirp3-HD-Charon',
  jsonb_build_object(
    'voices_per_lang', jsonb_build_object(
      'en', 'en-US-Chirp3-HD-Charon',
      'de', 'de-DE-Chirp3-HD-Charon',
      'es', 'es-ES-Chirp3-HD-Charon',
      'fr', 'fr-FR-Chirp3-HD-Charon',
      'ar', 'Charon',
      'zh', 'Charon',
      'ru', 'Charon',
      'sr', 'Charon'
    )
  )
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
