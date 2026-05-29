-- =============================================================================
-- VTID-03031: Devon TTS parity — male Chirp3-HD-Charon voice across languages
-- =============================================================================
-- Before this migration: Devon has NO row in agent_voice_configs. On persona
-- swap, the gateway returns voice_config=null; the agent's build_cascade()
-- falls through to the hardcoded Google fallback (Aoede), and then
-- _resolve_tts_voice() picks LANG_DEFAULTS["google_tts"][lang] — which is
-- de-DE-Chirp3-HD-Leda (FEMALE) for German and en-US-Chirp3-HD-Aoede (FEMALE)
-- for English. Result: Devon speaks in Vitana's voice.
--
-- This migration inserts Devon's row with tts_options.voices_per_lang mapping
-- every supported language to its Chirp3-HD-Charon variant (MALE). The agent
-- cascade resolver (_resolve_tts_voice in providers.py) checks voices_per_lang
-- BEFORE LANG_DEFAULTS, so Devon now speaks as Charon regardless of locale.
--
-- For ar/zh/ru/sr (where Chirp3-HD coverage is thin) we use the bare 'Charon'
-- name which routes through the gemini-2.5-flash-tts multilingual model — same
-- approach as LANG_DEFAULTS uses today.
--
-- Vitana is intentionally left WITHOUT a row so she continues to fall through
-- to the LANG_DEFAULTS chain (Aoede for en/es/fr, Leda for de) — the current
-- "default" the user accepts.
-- =============================================================================

BEGIN;

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
