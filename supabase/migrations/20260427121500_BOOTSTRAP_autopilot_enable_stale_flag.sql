-- =============================================================================
-- Autopilot — first scanner allowlisted for unattended auto-approve
-- =============================================================================
-- Operator decision (2026-04-27): start the autonomous loop with the
-- safest single scanner. stale-feature-flag-scanner-v1 emits findings
-- for feature flags that haven't been toggled in 90+ days — small blast
-- radius, deterministic fix (delete a flag and its references).
--
-- Caps:
--   daily_budget = 5      → at most 5 unattended executions/day across
--                            ALL scanners (not per-scanner; this is the
--                            existing cap, narrowed from 10).
--   risk_classes = ['low'] → tightened from default ['low','medium'] so
--                            a future scanner addition doesn't silently
--                            broaden the gate.
--   max_effort   = 5      → unchanged (already the default).
--
-- Rollback: re-run with auto_approve_enabled=FALSE OR clear the array.
-- All progress is recorded in dev_autopilot_outcomes for audit.
-- =============================================================================

UPDATE public.dev_autopilot_config
SET auto_approve_enabled    = TRUE,
    auto_approve_scanners   = ARRAY['stale-feature-flag-scanner-v1']::text[],
    auto_approve_risk_classes = ARRAY['low']::text[],
    daily_budget            = 5,
    updated_at              = NOW()
WHERE id = 1;

-- Audit row in oasis_events so the autonomy graduation policy + dashboards
-- have a clear "moment" to anchor on.
INSERT INTO public.oasis_events (vtid, type, topic, source, status, message, metadata)
VALUES (
  'BOOTSTRAP-AUTOPILOT-FIRST-SCANNER',
  'dev_autopilot.config.auto_approve_enabled',
  'dev_autopilot.config.auto_approve_enabled',
  'autopilot-realign',
  'success',
  'Auto-approve enabled for stale-feature-flag-scanner-v1 (daily_budget=5, risk=low)',
  jsonb_build_object(
    'scanners', ARRAY['stale-feature-flag-scanner-v1'],
    'risk_classes', ARRAY['low'],
    'daily_budget', 5,
    'enabled_at', NOW()
  )
);
