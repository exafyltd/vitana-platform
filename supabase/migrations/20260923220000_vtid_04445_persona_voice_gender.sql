-- VTID-04445 — owner rule (2026-09-23): every Vitana voice, in every language,
-- is a woman's voice; every Devon voice, in every language, is a man's voice.
--
-- Data only. Brings the stored voice rows in line with the rule:
--   1. decision_policy voice.live_api.voice.{fr,es} — Vitana's Gemini voice
--      for French was Charon and for Spanish Fenrir, both MALE voices
--      (Google Chirp 3 HD voice table). → Leda / Autonoe (female), matching
--      the code fallbacks in orb/live/voice/live-api-voice.ts.
--   2. agent_voice_configs 'orb-agent' (Vitana on the LiveKit path) — gets an
--      explicit female voice per language. Without it the agent's code
--      defaults served Charon (male) for ar/zh/ru/sr.
--   3. agent_voice_configs 'devon' — pt/pl/tr added (Charon, male); those
--      languages previously fell through to the English override.
--
-- Idempotent: every statement sets absolute values.

update decision_policy
   set value_json = '{"voice_name": "Leda", "fallback_lang": null}'::jsonb,
       notes = 'VTID-04445: Vitana voice must be female — was Charon (male). LIVE_API_VOICES.fr'
 where policy_key = 'voice.live_api.voice.fr' and tenant_id is null;

update decision_policy
   set value_json = '{"voice_name": "Autonoe", "fallback_lang": null}'::jsonb,
       notes = 'VTID-04445: Vitana voice must be female — was Fenrir (male). LIVE_API_VOICES.es'
 where policy_key = 'voice.live_api.voice.es' and tenant_id is null;

update agent_voice_configs
   set tts_options = coalesce(tts_options, '{}'::jsonb) || jsonb_build_object(
         'voices_per_lang', jsonb_build_object(
           'en', 'en-US-Chirp3-HD-Aoede',
           'de', 'de-DE-Chirp3-HD-Leda',
           'es', 'es-ES-Chirp3-HD-Aoede',
           'fr', 'fr-FR-Chirp3-HD-Aoede',
           'ar', 'Kore',
           'zh', 'Kore',
           'ru', 'Kore',
           'sr', 'Kore',
           'pt', 'Zephyr',
           'pl', 'Despina',
           'tr', 'Pulcherrima'
         )),
       updated_at = now()
 where agent_id = 'orb-agent';

update agent_voice_configs
   set tts_options = jsonb_set(
         coalesce(tts_options, '{}'::jsonb),
         '{voices_per_lang}',
         coalesce(tts_options->'voices_per_lang', '{}'::jsonb)
           || '{"pt": "Charon", "pl": "Charon", "tr": "Charon"}'::jsonb),
       updated_at = now()
 where agent_id = 'devon';
