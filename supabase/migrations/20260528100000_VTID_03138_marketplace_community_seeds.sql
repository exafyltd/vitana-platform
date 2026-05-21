-- Phase C.7 + C.8 (decision-contract refactor) — marketplace + community analyzer seeds.
--
-- VTID-03138. Externalizes 16 literals across two ranker files:
--   - marketplace-analyzer.ts: 9 weights (TOP_PICKS_PER_USER,
--     PRODUCT_CANDIDATE_LIMIT, ingredient rank decay, evidence
--     multipliers, goal-fit boost, region boost, rating boost cap,
--     past-purchase penalty, confidence base)
--   - community-user-analyzer.ts: 7 thresholds (PILLAR_WEAKNESS_THRESHOLD,
--     decline-trend gate, 5 onboarding-stage day boundaries)
--
-- Idempotent. Values byte-identical to literals.

-- =========================================================================
-- C.7 marketplace-analyzer
-- =========================================================================

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.marketplace.top_picks_per_user', NULL, 1, '5'::jsonb, 'seed',
       'marketplace-analyzer.ts:74 (TOP_PICKS_PER_USER)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.marketplace.top_picks_per_user' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.marketplace.product_candidate_limit', NULL, 1, '100'::jsonb, 'seed',
       'marketplace-analyzer.ts:75 (PRODUCT_CANDIDATE_LIMIT)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.marketplace.product_candidate_limit' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.marketplace.ingredient_rank_base', NULL, 1, '0.5'::jsonb, 'seed',
       'marketplace-analyzer.ts:150 (rank-1 ingredient boost; formula 0.5 - (rank-1)*0.08)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.marketplace.ingredient_rank_base' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.marketplace.ingredient_rank_decay', NULL, 1, '0.08'::jsonb, 'seed',
       'marketplace-analyzer.ts:150 (per-rank decay step)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.marketplace.ingredient_rank_decay' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.marketplace.evidence_multipliers', NULL, 1, '{"strong":1.0,"moderate":0.8,"weak":0.5}'::jsonb, 'seed',
       'marketplace-analyzer.ts:151 (evidence band → multiplier)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.marketplace.evidence_multipliers' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.marketplace.goal_match_boost', NULL, 1, '0.2'::jsonb, 'seed',
       'marketplace-analyzer.ts:167 (goal-fit boost)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.marketplace.goal_match_boost' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.marketplace.same_region_bonus', NULL, 1, '0.15'::jsonb, 'seed',
       'marketplace-analyzer.ts:174 (same-region origin proximity)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.marketplace.same_region_bonus' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.marketplace.rating_boost_cap', NULL, 1, '0.1'::jsonb, 'seed',
       'marketplace-analyzer.ts:180 (rating boost cap; formula (rating-3)/2 * 0.1)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.marketplace.rating_boost_cap' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.marketplace.past_purchase_penalty', NULL, 1, '-1.0'::jsonb, 'seed',
       'marketplace-analyzer.ts:189 (don''t re-recommend past purchases)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.marketplace.past_purchase_penalty' AND tenant_id IS NULL AND version = 1);

-- =========================================================================
-- C.8 community-user-analyzer
-- =========================================================================

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'analyzer.community.pillar_weakness_threshold', NULL, 1, '80'::jsonb, 'seed',
       'community-user-analyzer.ts:53 (PILLAR_WEAKNESS_THRESHOLD — pillar < 80 → weakness flagged)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'analyzer.community.pillar_weakness_threshold' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'analyzer.community.decline_trend_drop_points', NULL, 1, '10'::jsonb, 'seed',
       'community-user-analyzer.ts:71 (pillar dropped ≥10 points vs previous → declining)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'analyzer.community.decline_trend_drop_points' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'analyzer.community.onboarding_stage.day1_after_days', NULL, 1, '1'::jsonb, 'seed',
       'community-user-analyzer.ts:505 (daysSinceCreation < 1 → day0)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'analyzer.community.onboarding_stage.day1_after_days' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'analyzer.community.onboarding_stage.day3_after_days', NULL, 1, '3'::jsonb, 'seed',
       'community-user-analyzer.ts:506 (daysSinceCreation < 3 → day1)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'analyzer.community.onboarding_stage.day3_after_days' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'analyzer.community.onboarding_stage.day7_after_days', NULL, 1, '7'::jsonb, 'seed',
       'community-user-analyzer.ts:507 (daysSinceCreation < 7 → day3)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'analyzer.community.onboarding_stage.day7_after_days' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'analyzer.community.onboarding_stage.day14_after_days', NULL, 1, '14'::jsonb, 'seed',
       'community-user-analyzer.ts:508 (daysSinceCreation < 14 → day7)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'analyzer.community.onboarding_stage.day14_after_days' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'analyzer.community.onboarding_stage.day30plus_after_days', NULL, 1, '30'::jsonb, 'seed',
       'community-user-analyzer.ts:509 (daysSinceCreation < 30 → day14; else day30plus)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'analyzer.community.onboarding_stage.day30plus_after_days' AND tenant_id IS NULL AND version = 1);
