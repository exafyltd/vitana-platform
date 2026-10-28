-- ============================================================================
-- Push Dispatch Tracking Column
-- ============================================================================
-- Adds push_sent_at to user_notifications so the push-dispatch cron
-- can identify trigger-created notifications that need FCM delivery.
--
-- Gateway's notifyUser() sets push_sent_at immediately after FCM send.
-- DB triggers (chat messages, group invites, etc.) leave it NULL.
-- The push-dispatch cron picks up NULL rows and sends FCM for them.
-- ============================================================================

-- Add the tracking column (nullable — NULL means not yet pushed)
ALTER TABLE user_notifications
  ADD COLUMN IF NOT EXISTS push_sent_at TIMESTAMPTZ DEFAULT NULL;

-- Index for the cron query: find un-pushed notifications efficiently
CREATE INDEX IF NOT EXISTS idx_user_notifications_push_pending
  ON user_notifications (created_at DESC)
  WHERE push_sent_at IS NULL
    AND channel IN ('push', 'push_and_inapp');
