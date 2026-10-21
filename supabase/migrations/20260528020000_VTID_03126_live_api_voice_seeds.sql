-- Phase D.3 (decision-contract refactor) — Live API voice mapping seeds.
--
-- VTID-03126. Externalizes `LIVE_API_VOICES` from
-- `services/gateway/src/routes/orb-live.ts:1341` into the
-- `decision_policy` table. Each row carries `{voice_name, fallback_lang}`
-- so the accessor can emit telemetry when a non-native fallback voice
-- is selected — closes the silent "Arabic → English Aoede" audit finding.
--
-- Idempotent: each INSERT is guarded by WHERE NOT EXISTS against the
-- same (key, tenant, version). Safe to re-run.
--
-- Values are BYTE-IDENTICAL to the LIVE_API_VOICES Record. The
-- `fallback_lang` field is "en" for languages currently using an English
-- voice as fallback; null for native-voice rows.

-- Native voices (no fallback)
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_api.voice.en', NULL, 1,
       '{"voice_name":"Aoede","fallback_lang":null}'::jsonb,
       'seed',
       'orb-live.ts:1342 (LIVE_API_VOICES.en — native English voice)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.live_api.voice.en' AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_api.voice.de', NULL, 1,
       '{"voice_name":"Kore","fallback_lang":null}'::jsonb,
       'seed',
       'orb-live.ts:1343 (LIVE_API_VOICES.de — native German voice)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.live_api.voice.de' AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_api.voice.fr', NULL, 1,
       '{"voice_name":"Charon","fallback_lang":null}'::jsonb,
       'seed',
       'orb-live.ts:1344 (LIVE_API_VOICES.fr — native French voice)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.live_api.voice.fr' AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_api.voice.es', NULL, 1,
       '{"voice_name":"Fenrir","fallback_lang":null}'::jsonb,
       'seed',
       'orb-live.ts:1345 (LIVE_API_VOICES.es — native Spanish voice)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.live_api.voice.es' AND tenant_id IS NULL AND version = 1
);

-- Languages currently using an English voice as fallback. The
-- fallback_lang field marks them so the accessor can emit telemetry
-- whenever they are read. Once a native voice ships for these
-- languages, replace the row with `fallback_lang: null` and a new
-- voice_name.
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_api.voice.ar', NULL, 1,
       '{"voice_name":"Aoede","fallback_lang":"en"}'::jsonb,
       'seed',
       'orb-live.ts:1346 (LIVE_API_VOICES.ar — silent English-voice fallback; telemetry will fire on each read until a native Arabic voice is shipped)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.live_api.voice.ar' AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_api.voice.zh', NULL, 1,
       '{"voice_name":"Kore","fallback_lang":"de"}'::jsonb,
       'seed',
       'orb-live.ts:1347 (LIVE_API_VOICES.zh — silent fallback to German "Kore"; telemetry will fire on each read until a native Chinese voice is shipped)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.live_api.voice.zh' AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_api.voice.ru', NULL, 1,
       '{"voice_name":"Aoede","fallback_lang":"en"}'::jsonb,
       'seed',
       'orb-live.ts:1348 (LIVE_API_VOICES.ru — silent English-voice fallback; telemetry will fire on each read)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.live_api.voice.ru' AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.live_api.voice.sr', NULL, 1,
       '{"voice_name":"Aoede","fallback_lang":"en"}'::jsonb,
       'seed',
       'orb-live.ts:1349 (LIVE_API_VOICES.sr — silent English-voice fallback; telemetry will fire on each read)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.live_api.voice.sr' AND tenant_id IS NULL AND version = 1
);
