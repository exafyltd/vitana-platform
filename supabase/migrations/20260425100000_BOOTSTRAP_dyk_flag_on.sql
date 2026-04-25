-- BOOTSTRAP-DYK-TOUR — flip vitana_did_you_know_enabled ON
-- 2026-04-25, after Phase 1a (gateway) + Phase 2 (vitana-v1) deploys.
-- Idempotent: re-running is a no-op once enabled=TRUE.

UPDATE public.system_controls
SET enabled = TRUE,
    updated_at = NOW(),
    updated_by = 'BOOTSTRAP-DYK-TOUR-SMOKE',
    updated_by_role = 'system',
    reason = 'Phase 2 frontend deployed + backend verified. Enabling tour for smoke test.'
WHERE key = 'vitana_did_you_know_enabled';
