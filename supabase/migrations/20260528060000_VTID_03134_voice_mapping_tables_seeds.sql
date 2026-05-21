-- Phase D.3.b-e (decision-contract refactor) — voice mapping table seeds.
--
-- VTID-03134. Externalizes the remaining 4 voice-mapping Records from
-- `services/gateway/src/routes/orb-live.ts`:
--   - LIVE_LANGUAGE_VOICES   → voice.live_language.<lang>   (8 rows)
--   - GEMINI_TTS_VOICES      → voice.gemini_tts.<lang>      (8 rows)
--   - NEURAL2_TTS_VOICES     → voice.neural2_tts.<lang>     (8 rows)
--   - NEURAL2_ENABLED_LANGUAGES → voice.neural2.enabled_languages (1 row)
--
-- Idempotent. Values are BYTE-IDENTICAL to the Record entries at the
-- time of writing. Accessor functions in
-- `services/gateway/src/orb/live/voice/voice-mapping.ts` use the same
-- literals as cache-cold safety nets so a missing row falls back to
-- today's behaviour silently.

-- =========================================================================
-- LIVE_LANGUAGE_VOICES (Gemini Live voice names per lang)
-- =========================================================================
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_language.en', NULL, 1, '"Callirrhoe"'::jsonb, 'seed',
       'orb-live.ts:753 (LIVE_LANGUAGE_VOICES.en — female Gemini Live voice)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.live_language.en' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_language.de', NULL, 1, '"Achernar"'::jsonb, 'seed',
       'orb-live.ts:754 (LIVE_LANGUAGE_VOICES.de)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.live_language.de' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_language.fr', NULL, 1, '"Leda"'::jsonb, 'seed',
       'orb-live.ts:755 (LIVE_LANGUAGE_VOICES.fr)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.live_language.fr' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_language.es', NULL, 1, '"Aoede"'::jsonb, 'seed',
       'orb-live.ts:756 (LIVE_LANGUAGE_VOICES.es)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.live_language.es' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_language.ar', NULL, 1, '"Sulafat"'::jsonb, 'seed',
       'orb-live.ts:757 (LIVE_LANGUAGE_VOICES.ar)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.live_language.ar' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_language.zh', NULL, 1, '"Laomedeia"'::jsonb, 'seed',
       'orb-live.ts:758 (LIVE_LANGUAGE_VOICES.zh)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.live_language.zh' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_language.sr', NULL, 1, '"Vindemiatrix"'::jsonb, 'seed',
       'orb-live.ts:759 (LIVE_LANGUAGE_VOICES.sr)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.live_language.sr' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_language.ru', NULL, 1, '"Gacrux"'::jsonb, 'seed',
       'orb-live.ts:760 (LIVE_LANGUAGE_VOICES.ru)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.live_language.ru' AND tenant_id IS NULL AND version = 1);

-- =========================================================================
-- GEMINI_TTS_VOICES (Cloud TTS Gemini-model voices per lang)
-- =========================================================================
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.gemini_tts.en', NULL, 1, '{"name":"Kore","languageCode":"en-US"}'::jsonb, 'seed',
       'orb-live.ts:1252 (GEMINI_TTS_VOICES.en)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.gemini_tts.en' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.gemini_tts.de', NULL, 1, '{"name":"Kore","languageCode":"de-DE"}'::jsonb, 'seed',
       'orb-live.ts:1253 (GEMINI_TTS_VOICES.de)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.gemini_tts.de' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.gemini_tts.fr', NULL, 1, '{"name":"Kore","languageCode":"fr-FR"}'::jsonb, 'seed',
       'orb-live.ts:1254 (GEMINI_TTS_VOICES.fr)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.gemini_tts.fr' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.gemini_tts.es', NULL, 1, '{"name":"Kore","languageCode":"es-ES"}'::jsonb, 'seed',
       'orb-live.ts:1255 (GEMINI_TTS_VOICES.es)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.gemini_tts.es' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.gemini_tts.ar', NULL, 1, '{"name":"Kore","languageCode":"ar-XA"}'::jsonb, 'seed',
       'orb-live.ts:1256 (GEMINI_TTS_VOICES.ar)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.gemini_tts.ar' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.gemini_tts.zh', NULL, 1, '{"name":"Kore","languageCode":"cmn-CN"}'::jsonb, 'seed',
       'orb-live.ts:1257 (GEMINI_TTS_VOICES.zh)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.gemini_tts.zh' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.gemini_tts.sr', NULL, 1, '{"name":"Kore","languageCode":"sr-RS"}'::jsonb, 'seed',
       'orb-live.ts:1258 (GEMINI_TTS_VOICES.sr)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.gemini_tts.sr' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.gemini_tts.ru', NULL, 1, '{"name":"Kore","languageCode":"ru-RU"}'::jsonb, 'seed',
       'orb-live.ts:1259 (GEMINI_TTS_VOICES.ru)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.gemini_tts.ru' AND tenant_id IS NULL AND version = 1);

-- =========================================================================
-- NEURAL2_TTS_VOICES (Cloud TTS Neural2/WaveNet/Standard fallback chain)
-- =========================================================================
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.neural2_tts.de', NULL, 1, '{"name":"de-DE-Neural2-G","languageCode":"de-DE"}'::jsonb, 'seed',
       'orb-live.ts:1271 (Neural2 female German)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.neural2_tts.de' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.neural2_tts.en', NULL, 1, '{"name":"en-US-Neural2-H","languageCode":"en-US"}'::jsonb, 'seed',
       'orb-live.ts:1272 (Neural2 female English)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.neural2_tts.en' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.neural2_tts.fr', NULL, 1, '{"name":"fr-FR-Neural2-A","languageCode":"fr-FR"}'::jsonb, 'seed',
       'orb-live.ts:1273 (Neural2 female French)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.neural2_tts.fr' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.neural2_tts.es', NULL, 1, '{"name":"es-ES-Neural2-A","languageCode":"es-ES"}'::jsonb, 'seed',
       'orb-live.ts:1274 (Neural2 female Spanish)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.neural2_tts.es' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.neural2_tts.ar', NULL, 1, '{"name":"ar-XA-Wavenet-D","languageCode":"ar-XA"}'::jsonb, 'seed',
       'orb-live.ts:1275 (WaveNet female Arabic — Neural2 not available)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.neural2_tts.ar' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.neural2_tts.zh', NULL, 1, '{"name":"cmn-CN-Wavenet-A","languageCode":"cmn-CN"}'::jsonb, 'seed',
       'orb-live.ts:1276 (WaveNet female Chinese — Neural2 not available)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.neural2_tts.zh' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.neural2_tts.ru', NULL, 1, '{"name":"ru-RU-Wavenet-A","languageCode":"ru-RU"}'::jsonb, 'seed',
       'orb-live.ts:1277 (WaveNet female Russian — Neural2 not available)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.neural2_tts.ru' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.neural2_tts.sr', NULL, 1, '{"name":"sr-RS-Standard-A","languageCode":"sr-RS"}'::jsonb, 'seed',
       'orb-live.ts:1278 (Standard female Serbian — Neural2/WaveNet not available)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.neural2_tts.sr' AND tenant_id IS NULL AND version = 1);

-- =========================================================================
-- NEURAL2_ENABLED_LANGUAGES (array — which langs prefer Neural2 over Gemini TTS)
-- =========================================================================
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.neural2.enabled_languages', NULL, 1,
       '["en","de","fr","es","ar","zh","ru","sr"]'::jsonb,
       'seed',
       'orb-live.ts:1282 (NEURAL2_ENABLED_LANGUAGES — all 8 supported langs use best-available TTS chain)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'voice.neural2.enabled_languages' AND tenant_id IS NULL AND version = 1);
