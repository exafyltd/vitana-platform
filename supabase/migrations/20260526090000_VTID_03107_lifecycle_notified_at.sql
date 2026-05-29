-- =============================================================================
-- VTID-03107 · Billing v1 — lifecycle_notification_state.notified_at column
-- =============================================================================
-- Adds the column the gateway lifecycle-notification-worker reads to find
-- un-dispatched rows. NULL = pending notification; non-null = worker
-- already fanned out via notifyUserAsync.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS lets the migration re-run safely.
-- =============================================================================

ALTER TABLE public.lifecycle_notification_state
  ADD COLUMN IF NOT EXISTS notified_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_lifecycle_notification_state_pending
  ON public.lifecycle_notification_state (fired_at DESC)
  WHERE notified_at IS NULL;

COMMENT ON COLUMN public.lifecycle_notification_state.notified_at IS
  'VTID-03107: when the gateway lifecycle-notification-worker fanned this row out via notifyUserAsync. NULL = pending. Index supports the worker''s polling query.';
