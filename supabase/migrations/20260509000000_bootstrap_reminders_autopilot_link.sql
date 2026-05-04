-- =============================================================================
-- BOOTSTRAP-REMINDERS-AUTOPILOT-LINK
-- =============================================================================
-- Path A of the Reminders ↔ Autopilot integration plan:
-- adds a one-directional link from autopilot_recommendations to a reminder
-- created on its behalf. Server-side callers (recommendation engine, future
-- automation handlers) populate this when they spawn a `created_via='system'`
-- reminder so the row is identifiable as "Suggested by Vitana" on the
-- frontend (vitana-v1 PR #349).
--
-- Schema changes are additive and nullable — no backfill, no behavior change
-- until a caller starts populating the column.
--
-- Idempotent: safe to re-run. Uses IF NOT EXISTS guards per repo convention.
-- =============================================================================

-- 1. Add the link column.
ALTER TABLE autopilot_recommendations
  ADD COLUMN IF NOT EXISTS linked_reminder_id UUID
    REFERENCES reminders(id) ON DELETE SET NULL;

COMMENT ON COLUMN autopilot_recommendations.linked_reminder_id IS
  'When set, points at a created_via=system reminder spawned for this recommendation. Cleared automatically if the reminder is deleted.';

-- 2. Index for forward lookup (recommendation → reminder).
CREATE INDEX IF NOT EXISTS idx_autopilot_recommendations_linked_reminder
  ON autopilot_recommendations(linked_reminder_id)
  WHERE linked_reminder_id IS NOT NULL;

-- 3. Reload PostgREST schema cache so the new column is visible to API clients.
NOTIFY pgrst, 'reload schema';
