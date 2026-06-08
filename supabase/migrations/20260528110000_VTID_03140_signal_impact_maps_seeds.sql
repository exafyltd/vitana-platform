-- Phase C.6 (decision-contract refactor) — signal→impact maps.
--
-- VTID-03140. Externalizes the 6 hardcoded impactMap tables (codebase,
-- OASIS, health, LLM, marketplace, wearable) in
-- `services/gateway/src/services/recommendation-engine/recommendation-generator.ts`.
--
-- One JSONB row per signal_type. The user-approved schema is:
--   {
--     "version": 1,
--     "impacts": {
--       "<signal_key>": { "impact": <int>, "weight": <int>, "rationale": "..." }
--     }
--   }
--
-- Categorical maps (codebase / OASIS / health) use the raw signal.type as
-- the key. Ladder maps (LLM / marketplace / wearable) encode the existing
-- 3-tier ladder as named keys 'high' / 'mid' / 'low'; the runtime accessor
-- picks the right bucket. Values byte-identical to the literals they
-- replace. Idempotent.

-- =========================================================================
-- C.6.a — codebase signal impact map
-- =========================================================================
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'recommendation.signal_impact.codebase', NULL, 1,
       '{
         "version": 1,
         "impacts": {
           "todo":          { "impact": 5, "weight": 1, "rationale": "Inline TODO — small but real follow-up" },
           "large_file":    { "impact": 6, "weight": 1, "rationale": "Refactor candidate — affects readability + diffability" },
           "missing_tests": { "impact": 7, "weight": 1, "rationale": "Quality + regression risk" },
           "dead_code":     { "impact": 4, "weight": 1, "rationale": "Cleanup, no functional gain" },
           "duplication":   { "impact": 5, "weight": 1, "rationale": "Maintenance + drift risk" },
           "missing_docs":  { "impact": 3, "weight": 1, "rationale": "Onboarding friction; lowest ranked" }
         }
       }'::jsonb,
       'seed', 'recommendation-generator.ts:175-182 (convertCodebaseSignal impactMap)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'recommendation.signal_impact.codebase' AND tenant_id IS NULL AND version = 1);

-- =========================================================================
-- C.6.b — OASIS signal impact map
-- =========================================================================
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'recommendation.signal_impact.oasis', NULL, 1,
       '{
         "version": 1,
         "impacts": {
           "error_pattern":      { "impact": 8, "weight": 1, "rationale": "Recurring error — high user impact" },
           "slow_endpoint":      { "impact": 7, "weight": 1, "rationale": "Latency degrades UX" },
           "failed_deploy":      { "impact": 9, "weight": 1, "rationale": "Pipeline broken — blocks delivery" },
           "anomaly":            { "impact": 6, "weight": 1, "rationale": "Unexpected behaviour, investigate" },
           "underused_feature":  { "impact": 4, "weight": 1, "rationale": "Adoption signal, not urgent" }
         }
       }'::jsonb,
       'seed', 'recommendation-generator.ts:224-230 (convertOasisSignal impactMap)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'recommendation.signal_impact.oasis' AND tenant_id IS NULL AND version = 1);

-- =========================================================================
-- C.6.c — health signal impact map
-- =========================================================================
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'recommendation.signal_impact.health', NULL, 1,
       '{
         "version": 1,
         "impacts": {
           "missing_index":   { "impact": 7, "weight": 1, "rationale": "Performance hot-spot at scale" },
           "large_table":     { "impact": 6, "weight": 1, "rationale": "Archival/retention candidate" },
           "missing_rls":     { "impact": 9, "weight": 1, "rationale": "Security — tenant isolation gap" },
           "env_gap":         { "impact": 8, "weight": 1, "rationale": "Configuration drift, breaks features" },
           "stale_migration": { "impact": 5, "weight": 1, "rationale": "Schema lag, low blast radius" }
         }
       }'::jsonb,
       'seed', 'recommendation-generator.ts:257-263 (convertHealthSignal impactMap)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'recommendation.signal_impact.health' AND tenant_id IS NULL AND version = 1);

-- =========================================================================
-- C.6.d — LLM signal impact ladder (confidence-tiered)
-- Source code: `signal.confidence > 0.8 ? 8 : signal.confidence > 0.5 ? 6 : 4`
-- Keys: high (>0.8) / mid (>0.5) / low (else)
-- =========================================================================
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'recommendation.signal_impact.llm', NULL, 1,
       '{
         "version": 1,
         "impacts": {
           "high": { "impact": 8, "weight": 1, "rationale": "confidence > 0.8 — strong LLM judgement" },
           "mid":  { "impact": 6, "weight": 1, "rationale": "0.5 < confidence ≤ 0.8 — qualified" },
           "low":  { "impact": 4, "weight": 1, "rationale": "confidence ≤ 0.5 — speculative" }
         }
       }'::jsonb,
       'seed', 'recommendation-generator.ts:303 (convertLLMSignal confidence ladder)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'recommendation.signal_impact.llm' AND tenant_id IS NULL AND version = 1);

-- =========================================================================
-- C.6.e — marketplace signal impact ladder (match_score-tiered)
-- Source code: `signal.match_score > 0.7 ? 8 : signal.match_score > 0.5 ? 6 : 4`
-- Keys: high (>0.7) / mid (>0.5) / low (else)
-- =========================================================================
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'recommendation.signal_impact.marketplace', NULL, 1,
       '{
         "version": 1,
         "impacts": {
           "high": { "impact": 8, "weight": 1, "rationale": "match_score > 0.7 — strong fit" },
           "mid":  { "impact": 6, "weight": 1, "rationale": "0.5 < match_score ≤ 0.7 — qualified" },
           "low":  { "impact": 4, "weight": 1, "rationale": "match_score ≤ 0.5 — exploratory" }
         }
       }'::jsonb,
       'seed', 'recommendation-generator.ts:348 (convertMarketplaceSignal match_score ladder)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'recommendation.signal_impact.marketplace' AND tenant_id IS NULL AND version = 1);

-- =========================================================================
-- C.6.f — wearable signal impact ladder (severity-tiered)
-- Source code: `severity === 'high' ? 8 : severity === 'medium' ? 6 : 4`
-- Keys map directly to severity strings.
-- =========================================================================
INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'recommendation.signal_impact.wearable', NULL, 1,
       '{
         "version": 1,
         "impacts": {
           "high":   { "impact": 8, "weight": 1, "rationale": "Clinical concern — flag prominently" },
           "medium": { "impact": 6, "weight": 1, "rationale": "Notable variance — surface" },
           "low":    { "impact": 4, "weight": 1, "rationale": "Routine trend information" }
         }
       }'::jsonb,
       'seed', 'recommendation-generator.ts:316 (convertWearableSignal severity ladder)'
WHERE NOT EXISTS (SELECT 1 FROM decision_policy WHERE policy_key = 'recommendation.signal_impact.wearable' AND tenant_id IS NULL AND version = 1);
