-- Phase D.4.a (decision-contract refactor) — voice cascade default seed.
--
-- VTID-03127. Seeds the `decision_policy` row that the gateway returns
-- as `voice_config` when no per-agent row exists in `agent_voice_configs`.
-- Before this row existed, the gateway returned `voice_config: null` in
-- that case, and the Python orb-agent at
-- `services/agents/orb-agent/src/orb_agent/providers.py:54-64` silently
-- fell back to a literal all-Google cascade — hiding any service-token
-- / config-fetch failure under what looked like a working voice path.
--
-- After D.4.a, the gateway returns this seeded default and the Python
-- fallback path becomes unreachable (D.4.b will remove the dead code).
-- The 6 fields are BYTE-IDENTICAL to the literals previously in
-- `providers.py:54-64`. To change the cascade for all agents, edit this
-- row's `value_json` — no code deploy required.
--
-- Idempotent: INSERT guarded by WHERE NOT EXISTS.

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.cascade.default', NULL, 1,
       jsonb_build_object(
         'stt_provider', 'google_stt',
         'stt_model',    'latest_long',
         'llm_provider', 'google_llm',
         'llm_model',    'gemini-3.1-flash-lite-preview',
         'tts_provider', 'google_tts',
         'tts_model',    'en-US-Chirp3-HD-Aoede'
       ),
       'seed',
       'orb-agent providers.py:54-64 — replaces the silent all-Google hardcoded fallback; gateway returns this when agent_voice_configs has no row for the agent'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.cascade.default' AND tenant_id IS NULL AND version = 1
);
