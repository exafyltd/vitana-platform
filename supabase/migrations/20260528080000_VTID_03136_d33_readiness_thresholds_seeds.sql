-- Phase B.7 (decision-contract refactor) — D33 readiness threshold seeds.
--
-- VTID-03136. Externalizes the 11 thresholds in `D33_THRESHOLDS` from
-- `services/gateway/src/types/availability-readiness.ts:482-505`.
-- Phase B.7 ships seeds + accessor; consumers (`d33-availability-readiness-engine.ts`)
-- continue to read `D33_THRESHOLDS.X` directly today — the const becomes
-- a proxy in the accompanying code change that delegates to PolicyResolver.
--
-- Idempotent. Values are BYTE-IDENTICAL to the literals at the time of writing.

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.readiness.monetization_min', NULL, 1, '0.6'::jsonb, 'seed',
       'availability-readiness.ts:484 (READINESS_MONETIZATION_MIN — payment/booking gate)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.readiness.monetization_min' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.readiness.deep_flow_min', NULL, 1, '0.5'::jsonb, 'seed',
       'availability-readiness.ts:485 (READINESS_DEEP_FLOW_MIN — extended engagement gate)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.readiness.deep_flow_min' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.readiness.light_flow_min', NULL, 1, '0.3'::jsonb, 'seed',
       'availability-readiness.ts:486 (READINESS_LIGHT_FLOW_MIN — light flows gate)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.readiness.light_flow_min' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.time_window.immediate_max_minutes', NULL, 1, '2'::jsonb, 'seed',
       'availability-readiness.ts:489 (TIME_IMMEDIATE_MAX — ≤2 min = quick nudge only)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.time_window.immediate_max_minutes' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.time_window.short_max_minutes', NULL, 1, '10'::jsonb, 'seed',
       'availability-readiness.ts:490 (TIME_SHORT_MAX — 2-10 min = brief flow window)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.time_window.short_max_minutes' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.confidence.min_for_action', NULL, 1, '50'::jsonb, 'seed',
       'availability-readiness.ts:493 (MIN_CONFIDENCE_FOR_ACTION — score threshold to act)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.confidence.min_for_action' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.response_time.fast_threshold_seconds', NULL, 1, '5'::jsonb, 'seed',
       'availability-readiness.ts:496 (FAST_RESPONSE_THRESHOLD — <5s = high engagement, score +10)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.response_time.fast_threshold_seconds' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.response_time.slow_threshold_seconds', NULL, 1, '30'::jsonb, 'seed',
       'availability-readiness.ts:497 (SLOW_RESPONSE_THRESHOLD — >30s = distraction, score -15)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.response_time.slow_threshold_seconds' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.session_length.short_threshold_minutes', NULL, 1, '2'::jsonb, 'seed',
       'availability-readiness.ts:500 (SHORT_SESSION_THRESHOLD — <2 min = low commitment signal)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.session_length.short_threshold_minutes' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.session_length.long_threshold_minutes', NULL, 1, '15'::jsonb, 'seed',
       'availability-readiness.ts:501 (LONG_SESSION_THRESHOLD — >15 min = sustained engagement)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.session_length.long_threshold_minutes' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.override.expiry_minutes', NULL, 1, '30'::jsonb, 'seed',
       'availability-readiness.ts:504 (OVERRIDE_EXPIRY_MINUTES — user override expires after 30 min)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.override.expiry_minutes' AND tenant_id IS NULL AND version = 1);
