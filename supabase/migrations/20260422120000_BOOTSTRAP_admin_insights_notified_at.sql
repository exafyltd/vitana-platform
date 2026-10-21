-- =============================================================================
-- BOOTSTRAP-ADMIN-EE: urgent_notified_at column on admin_insights
--
-- Phase EE needs to deliver push + in-app notifications to tenant admins
-- the first time an insight becomes severity='urgent'. We track delivery
-- with a timestamp column so re-scans don't re-notify for the same signal.
--
-- Idempotent migration: safe to run twice.
-- =============================================================================

ALTER TABLE public.admin_insights
  ADD COLUMN IF NOT EXISTS urgent_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN public.admin_insights.urgent_notified_at IS
  'BOOTSTRAP-ADMIN-EE: set to NOW() when we fire admin_insight_urgent notifications. NULL = not yet notified. Reset to NULL if an insight transitions out of severity=urgent and back.';

-- Partial index for the post-scan query that finds un-notified urgent insights.
CREATE INDEX IF NOT EXISTS admin_insights_urgent_unnotified_idx
  ON public.admin_insights (tenant_id, created_at DESC)
  WHERE status = 'open' AND severity = 'urgent' AND urgent_notified_at IS NULL;
