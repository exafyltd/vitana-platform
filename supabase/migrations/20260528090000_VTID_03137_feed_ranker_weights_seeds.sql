-- Phase C.5 (decision-contract refactor) — feed-ranker weight seeds.
--
-- VTID-03137. Externalizes the 12 weight/threshold literals in
-- `services/gateway/src/services/feed-ranker.ts`. Accessor function
-- `getFeedRankerConfig()` reads via PolicyResolver with these values
-- as cache-cold defaults so behaviour is byte-identical at rollout.
--
-- Idempotent.

-- Lifecycle-stage personalization-weight blends
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.personalization_weight.onboarding', NULL, 1, '0.2'::jsonb, 'seed',
       'feed-ranker.ts:38 (defaultPersonalizationWeightForStage: onboarding)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.personalization_weight.onboarding' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.personalization_weight.early', NULL, 1, '0.45'::jsonb, 'seed',
       'feed-ranker.ts:40 (early lifecycle)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.personalization_weight.early' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.personalization_weight.established', NULL, 1, '0.7'::jsonb, 'seed',
       'feed-ranker.ts:42 (established lifecycle)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.personalization_weight.established' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.personalization_weight.mature', NULL, 1, '0.9'::jsonb, 'seed',
       'feed-ranker.ts:44 (mature lifecycle)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.personalization_weight.mature' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.personalization_weight.default', NULL, 1, '0.3'::jsonb, 'seed',
       'feed-ranker.ts:46 (default fallback)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.personalization_weight.default' AND tenant_id IS NULL AND version = 1);

-- Per-product score components
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.featured_boost', NULL, 1, '0.7'::jsonb, 'seed',
       'feed-ranker.ts:87 (featured-pin boost)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.featured_boost' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.rating_score_max', NULL, 1, '0.3'::jsonb, 'seed',
       'feed-ranker.ts:91 (rating score capped at 0.3; formula (rating-3)/2 * 0.3)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.rating_score_max' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.category_mix_weight', NULL, 1, '0.2'::jsonb, 'seed',
       'feed-ranker.ts:95 (category_mix multiplier)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.category_mix_weight' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.topic_affinity_cap', NULL, 1, '0.4'::jsonb, 'seed',
       'feed-ranker.ts:102 (topic_affinity per-category cap)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.topic_affinity_cap' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.condition_match_boost', NULL, 1, '0.3'::jsonb, 'seed',
       'feed-ranker.ts:110 (active-condition match boost)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.condition_match_boost' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.same_region_bonus', NULL, 1, '0.1'::jsonb, 'seed',
       'feed-ranker.ts:119 (same-region origin bonus)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.same_region_bonus' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.high_rating_threshold', NULL, 1, '4.5'::jsonb, 'seed',
       'feed-ranker.ts:123 (high-rating threshold; ≥4.5 stars triggers personalized bonus)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.high_rating_threshold' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.high_rating_bonus', NULL, 1, '0.1'::jsonb, 'seed',
       'feed-ranker.ts:124 (high-rating personalized bonus when threshold met)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.high_rating_bonus' AND tenant_id IS NULL AND version = 1);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'ranker.feed.budget_fit_bonus', NULL, 1, '0.05'::jsonb, 'seed',
       'feed-ranker.ts:128 (within-budget bonus)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'ranker.feed.budget_fit_bonus' AND tenant_id IS NULL AND version = 1);
