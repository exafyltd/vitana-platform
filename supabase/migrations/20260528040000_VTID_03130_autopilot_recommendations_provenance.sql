-- Phase C.1 (decision-contract refactor) — autopilot_recommendations.provenance.
--
-- VTID-03130. Adds a JSONB `provenance` column to `autopilot_recommendations`
-- so Phase C strategies can record WHICH signals contributed to a
-- recommendation's score and WHICH `decision_policy` rows fed in their
-- weights. Auditable rank trail.
--
-- Phase C.1 ships the schema + types only. Phase C.2 seeds the 21
-- ranker policy keys. Phase C.3 implements PillarWeighterStrategy.
-- Phase C.4 wires `rankBatch()` to call the strategy and persist
-- `provenance`. Until C.4 ships, all rows have `provenance: null`.
--
-- Idempotent. Nullable: existing rows survive untouched. No new indexes
-- added in this PR — analytics indexing is deferred until row volume
-- justifies it (the column may be filtered ad-hoc via `provenance ?
-- 'strategy_id'` for analysis).

ALTER TABLE autopilot_recommendations
  ADD COLUMN IF NOT EXISTS provenance JSONB;

COMMENT ON COLUMN autopilot_recommendations.provenance IS
  'Phase C (VTID-03130): JSON trail of which strategy + policy rows + signals produced this recommendation''s score. Shape: { strategy_id, strategy_version, computed_at, tenant_id, components: [{kind, name, weight_key, weight_value, signal, contribution}], final_score }. Null on legacy rows.';
