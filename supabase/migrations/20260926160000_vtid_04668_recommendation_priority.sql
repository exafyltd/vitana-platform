-- =============================================================================
-- VTID-04668 — Autopilot recommendations P2: evidence-based priority
-- (docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md §4 P2)
-- =============================================================================
-- Additive only. Two nullable columns on autopilot_recommendations and one
-- partial index for the developer listings. Written by the gateway
-- (services/gateway/src/services/recommendation-quality/scoring-service.ts)
-- for developer rows (user_id IS NULL); community rows keep NULL.
--
--   priority_score  value × confidence × success_odds / max(expected_cost_usd, 0.05)
--   quality         {version, value, confidence, success_odds,
--                    expected_cost_usd, expected_input_tokens, executable,
--                    basis{...}, scored_at} — plus, from VTID-04669,
--                    review / review_attempts written by the quality review.
--
-- Apply BEFORE the gateway code that writes these columns is deployed: a
-- PATCH naming an unknown column is rejected by PostgREST (the gateway logs
-- it and continues — scoring is fail-open — but nothing gets a score).
-- =============================================================================

ALTER TABLE public.autopilot_recommendations
  ADD COLUMN IF NOT EXISTS priority_score numeric;

ALTER TABLE public.autopilot_recommendations
  ADD COLUMN IF NOT EXISTS quality jsonb;

COMMENT ON COLUMN public.autopilot_recommendations.priority_score IS
  'VTID-04668: evidence-based priority for developer (user_id IS NULL) recommendations: value x confidence x success_odds / max(expected_cost_usd, 0.05). NULL = not scored yet (and always for community rows).';

COMMENT ON COLUMN public.autopilot_recommendations.quality IS
  'VTID-04668: score components {version, value, confidence, success_odds, expected_cost_usd, expected_input_tokens, executable, basis, scored_at}; VTID-04669 adds review {verdict, problem, evidence, files, acceptance, why_now, drop_reason, reviewed_at, provider, model} and review_attempts.';

CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_dev_priority
  ON public.autopilot_recommendations (status, priority_score DESC)
  WHERE user_id IS NULL;
