-- Phase C.2 (decision-contract refactor) — pillar weighter policy seeds.
--
-- VTID-03131. Seeds the 21 numeric thresholds + weights currently
-- hard-coded inside
-- `services/gateway/src/services/recommendation-engine/ranking/index-pillar-weighter.ts`.
-- Phase C.3 will implement `PillarWeighterStrategy` reading these rows
-- through `PolicyResolver` with these same values as the
-- safety-net `defaultValue`. Result: byte-identical scoring at
-- rollout, tunable without a deploy.
--
-- Idempotent: each INSERT guarded by WHERE NOT EXISTS against
-- (key, tenant, version). Safe to re-run.
--
-- Source citations point at the file:line where the literal lives
-- today so future audits can grep them.

-- ---- Multipliers / weights (10) -------------------------------------------

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.alpha_pillar', NULL, 1, '0.5'::jsonb, 'seed',
       'index-pillar-weighter.ts:108 (DEFAULT_RANKER_CONFIG.alpha_pillar — pillar-gap boost weight)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.alpha_pillar' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.alpha_wave', NULL, 1, '0.3'::jsonb, 'seed',
       'index-pillar-weighter.ts:109 (DEFAULT_RANKER_CONFIG.alpha_wave — journey-mode amplification, currently unused in final formula)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.alpha_wave' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.compass_boost', NULL, 1, '1.3'::jsonb, 'seed',
       'index-pillar-weighter.ts:110 (DEFAULT_RANKER_CONFIG.compass_boost — multiplier when rec source_ref matches active Life Compass goal)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.compass_boost' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.pillar_quota_max', NULL, 1, '0.40'::jsonb, 'seed',
       'index-pillar-weighter.ts:112 (DEFAULT_RANKER_CONFIG.pillar_quota_max — at most 40% of ranked output from any single pillar)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.pillar_quota_max' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.weakest_quota_max', NULL, 1, '0.60'::jsonb, 'seed',
       'index-pillar-weighter.ts:113 (DEFAULT_RANKER_CONFIG.weakest_quota_max — quota cap flips to 60% for the weakest pillar when balance_factor ≤ 0.7)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.weakest_quota_max' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.completion_dampener', NULL, 1, '0.3'::jsonb, 'seed',
       'index-pillar-weighter.ts:114 (DEFAULT_RANKER_CONFIG.completion_dampener — score × 0.3 when pillar was completed in last 24h)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.completion_dampener' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.plan_dampener', NULL, 1, '0.3'::jsonb, 'seed',
       'index-pillar-weighter.ts:115 (DEFAULT_RANKER_CONFIG.plan_dampener — score × 0.3 when voice just planned this pillar)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.plan_dampener' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.rejection_dampener_alpha', NULL, 1, '0.5'::jsonb, 'seed',
       'index-pillar-weighter.ts:116 (DEFAULT_RANKER_CONFIG.rejection_dampener_alpha — impact × (1 − 0.5 × dismissal_rate))'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.rejection_dampener_alpha' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.streak_reinforcement', NULL, 1, '1.3'::jsonb, 'seed',
       'index-pillar-weighter.ts:117 (DEFAULT_RANKER_CONFIG.streak_reinforcement — score × 1.3 when streak ≥ 3 days on start_streak rec)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.streak_reinforcement' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.community_momentum_boost', NULL, 1, '1.2'::jsonb, 'seed',
       'index-pillar-weighter.ts:118 (DEFAULT_RANKER_CONFIG.community_momentum_boost — score × 1.2 when ≥3 community completions/7d + mental pillar)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.community_momentum_boost' AND tenant_id IS NULL AND version = 1);

-- ---- Balance guard thresholds (3) ----------------------------------------

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.balance_unbalanced_at', NULL, 1, '0.7'::jsonb, 'seed',
       'index-pillar-weighter.ts:433 (balance_factor ≤ 0.7 → flip pillar_quota_max to weakest_quota_max)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.balance_unbalanced_at' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.balance_amplify_at', NULL, 1, '0.9'::jsonb, 'seed',
       'index-pillar-weighter.ts:310 (balance_factor ≤ 0.9 + weakest pillar → amplify contribution by balance_amplify_factor)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.balance_amplify_at' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.balance_amplify_factor', NULL, 1, '1.2'::jsonb, 'seed',
       'index-pillar-weighter.ts:311 (weight = 1.2 applied to weakest-pillar contribution when balance_factor ≤ 0.9)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.balance_amplify_factor' AND tenant_id IS NULL AND version = 1);

-- ---- Journey-mode decay curve (6) ----------------------------------------

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.journey_mode_day_break_1', NULL, 1, '7'::jsonb, 'seed',
       'index-pillar-weighter.ts:280 (computeJourneyMode: d ≤ 7 → mode 1.0 onramp)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.journey_mode_day_break_1' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.journey_mode_day_break_2', NULL, 1, '30'::jsonb, 'seed',
       'index-pillar-weighter.ts:281 (computeJourneyMode: d ≤ 30 → mode 1.0 → 0.5 over 23 days)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.journey_mode_day_break_2' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.journey_mode_day_break_3', NULL, 1, '90'::jsonb, 'seed',
       'index-pillar-weighter.ts:282 (computeJourneyMode: d ≤ 90 → mode 0.5 → 0.2 over 60 days)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.journey_mode_day_break_3' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.journey_mode_decay_1to2', NULL, 1, '0.5'::jsonb, 'seed',
       'index-pillar-weighter.ts:281 (mode decay from 1.0 to 0.5 between day_break_1 and day_break_2)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.journey_mode_decay_1to2' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.journey_mode_decay_2to3', NULL, 1, '0.3'::jsonb, 'seed',
       'index-pillar-weighter.ts:282 (mode decay from 0.5 to 0.2 between day_break_2 and day_break_3 — 0.3 spread)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.journey_mode_decay_2to3' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.journey_mode_terminal', NULL, 1, '0.2'::jsonb, 'seed',
       'index-pillar-weighter.ts:283 (computeJourneyMode: d > 90 → mode 0.2 Index-led terminal)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.journey_mode_terminal' AND tenant_id IS NULL AND version = 1);

-- ---- Misc (2) ------------------------------------------------------------

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.compass_decay_subtract', NULL, 1, '0.1'::jsonb, 'seed',
       'index-pillar-weighter.ts:286 (active_goal_category → mode = max(0.1, mode − 0.1))'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.compass_decay_subtract' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.pillar_weighter.pillar_score_cap', NULL, 1, '200'::jsonb, 'seed',
       'index-pillar-weighter.ts:307 (gap = max(0, min(1, (200 − pillar_score) / 200)) — Vitana Index per-pillar cap)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.pillar_weighter.pillar_score_cap' AND tenant_id IS NULL AND version = 1);
