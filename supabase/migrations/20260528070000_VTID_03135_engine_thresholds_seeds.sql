-- Phase B.5 + B.6 (decision-contract refactor) — engine threshold seeds.
--
-- VTID-03135. Batched migration of two small constant blocks:
--   - B.5 temporal-bucket motivation signal — single 14-day boundary
--     between `cooling` and `absent` motivation states.
--   - B.6 D32 time-of-day windows — 4 hour boundaries that classify
--     `early_morning` / `morning` / `afternoon` / `evening` / `late_evening`.
--
-- Idempotent. Values are BYTE-IDENTICAL to the literals at the time
-- of writing. Accessor functions read via PolicyResolver with these as
-- cache-cold defaults.

-- =========================================================================
-- B.5 — temporal-bucket motivation signal boundary
-- =========================================================================
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'session.motivation.cooling_to_absent_days', NULL, 1, '14'::jsonb, 'seed',
       'temporal-bucket.ts:136-137 (long bucket: ≤14d → cooling, >14d → absent)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'session.motivation.cooling_to_absent_days' AND tenant_id IS NULL AND version = 1);

-- =========================================================================
-- B.6 — D32 time-of-day window boundaries (5 buckets, 4 boundaries)
-- =========================================================================
-- Boundaries are inclusive-lower:
--   hour ∈ [early_morning_start, morning_start)   → early_morning
--   hour ∈ [morning_start, afternoon_start)        → morning
--   hour ∈ [afternoon_start, evening_start)        → afternoon
--   hour ∈ [evening_start, late_evening_start)     → evening
--   hour ∈ [late_evening_start, 24)                → late_evening
--   else                                            → 'night' (implicit pre-5am)

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.time_of_day.early_morning_start_hour', NULL, 1, '5'::jsonb, 'seed',
       'd32-situational-awareness-engine.ts:132 (hour >= 5 && hour < 8 → early_morning)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.time_of_day.early_morning_start_hour' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.time_of_day.morning_start_hour', NULL, 1, '8'::jsonb, 'seed',
       'd32-situational-awareness-engine.ts:133 (hour >= 8 && hour < 12 → morning)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.time_of_day.morning_start_hour' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.time_of_day.afternoon_start_hour', NULL, 1, '12'::jsonb, 'seed',
       'd32-situational-awareness-engine.ts:134 (hour >= 12 && hour < 17 → afternoon)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.time_of_day.afternoon_start_hour' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.time_of_day.evening_start_hour', NULL, 1, '17'::jsonb, 'seed',
       'd32-situational-awareness-engine.ts:135 (hour >= 17 && hour < 21 → evening)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.time_of_day.evening_start_hour' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'situational.time_of_day.late_evening_start_hour', NULL, 1, '21'::jsonb, 'seed',
       'd32-situational-awareness-engine.ts:136 (hour >= 21 && hour < 24 → late_evening)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'situational.time_of_day.late_evening_start_hour' AND tenant_id IS NULL AND version = 1);
