-- Phase D.1 (decision-contract refactor) — voice-pipeline threshold seeds.
--
-- VTID-03124. Externalizes the 9 numeric thresholds currently hard-coded
-- in `services/gateway/src/orb/upstream/constants.ts` into the
-- `decision_policy` table seeded by Phase B.1.
--
-- Idempotent: each INSERT is guarded by WHERE NOT EXISTS against the same
-- (key, tenant, version). Safe to re-run.
--
-- Values are BYTE-IDENTICAL to the constants exported by
-- `orb/upstream/constants.ts` at the time of writing. Tuning history is
-- captured in `notes`; the constants.ts file still carries the literal
-- as `*_FALLBACK` for the safety-net path when the resolver cache is
-- cold (e.g. boot before warm-up completes).

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.vad.silence_duration_ms', NULL, 1, '850'::jsonb, 'seed',
       'orb/upstream/constants.ts:34 (VTID-03019 tuning: trims ~350ms off end-of-turn latency vs 1200ms predecessor)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.vad.silence_duration_ms'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.post_turn.cooldown_ms', NULL, 1, '2000'::jsonb, 'seed',
       'orb/upstream/constants.ts:46 (VTID-ECHO-COOLDOWN: gates mic for 2s after turn_complete to prevent speaker echo on mobile)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.post_turn.cooldown_ms'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.silence_keepalive.interval_ms', NULL, 1, '3000'::jsonb, 'seed',
       'orb/upstream/constants.ts:53 (VTID-STREAM-SILENCE: check every 3s whether to send a 250ms silence frame to prevent Vertex idle-timeout)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.silence_keepalive.interval_ms'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.silence_keepalive.idle_threshold_ms', NULL, 1, '3000'::jsonb, 'seed',
       'orb/upstream/constants.ts:54 (VTID-STREAM-SILENCE: send silence frame after 3s of inbound idle)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.silence_keepalive.idle_threshold_ms'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.watchdog.greeting_timeout_ms', NULL, 1, '8000'::jsonb, 'seed',
       'orb/upstream/constants.ts:64 (VTID-WATCHDOG: stall recovery if no greeting bytes within 8s)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.watchdog.greeting_timeout_ms'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.watchdog.turn_response_timeout_ms', NULL, 1, '10000'::jsonb, 'seed',
       'orb/upstream/constants.ts:65 (VTID-WATCHDOG: stall recovery if no model response within 10s after user speech)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.watchdog.turn_response_timeout_ms'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.watchdog.forwarding_ack_timeout_ms', NULL, 1, '45000'::jsonb, 'seed',
       'orb/upstream/constants.ts:106 (VTID-FORWARDING-WATCHDOG: tuned via VTID-01984 to 45s for genuine first-turn cold-start tolerance)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.watchdog.forwarding_ack_timeout_ms'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.loop_guard.max_consecutive_model_turns', NULL, 1, '3'::jsonb, 'seed',
       'orb/upstream/constants.ts:115 (VTID-LOOPGUARD: after 3 model turns without user speech, pause silence keepalive so Vertex idles out the loop)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.loop_guard.max_consecutive_model_turns'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.loop_guard.max_consecutive_tool_calls', NULL, 1, '5'::jsonb, 'seed',
       'orb/upstream/constants.ts:122 (VTID-TOOLGUARD: after 5 consecutive tool calls, inject synthetic function_response so the model answers from gathered data)'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.loop_guard.max_consecutive_tool_calls'
    AND tenant_id IS NULL AND version = 1
);
