-- =============================================================================
-- Enable Proactive Opener for dev-sandbox testing
-- Date: 2026-04-19
--
-- This is an OPERATIONAL TOGGLE, not a schema migration. It flips
-- vitana_proactive_opener_enabled to TRUE so the Proactive Guide opener
-- becomes active in ORB voice + Assistant.
--
-- Default state from Phase 0 migration: FALSE.
-- Re-running this migration is idempotent.
--
-- TO DISABLE again, run:
--   UPDATE system_controls SET enabled = FALSE WHERE key = 'vitana_proactive_opener_enabled';
--
-- This file lives in supabase/migrations/ for traceability via RUN-MIGRATION.yml.
-- =============================================================================

UPDATE system_controls
SET
  enabled = TRUE,
  reason = 'Phase 0.5 voice testing — proactive opener with dismissal honor',
  updated_by = 'migration',
  updated_by_role = 'system',
  updated_at = NOW()
WHERE key = 'vitana_proactive_opener_enabled';

-- Verify the flip worked
DO $$
DECLARE
  v_enabled BOOLEAN;
BEGIN
  SELECT enabled INTO v_enabled FROM system_controls
  WHERE key = 'vitana_proactive_opener_enabled';

  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'system_controls row vitana_proactive_opener_enabled missing — Phase 0 migration not applied?';
  END IF;

  IF v_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'Failed to flip vitana_proactive_opener_enabled — current value: %', v_enabled;
  END IF;

  RAISE NOTICE 'vitana_proactive_opener_enabled = TRUE — Proactive Guide is LIVE in dev-sandbox';
END $$;
