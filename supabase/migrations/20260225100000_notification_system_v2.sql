-- =============================================================================
-- Notification System v2 — Add channel/priority columns + extra preference columns
-- Incremental migration — safe to run on top of 20260225000000
-- =============================================================================

-- 1. Add channel + priority columns to user_notifications (if missing)
ALTER TABLE user_notifications
  ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'push_and_inapp',
  ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'p2';

-- 2. Add extra preference columns to user_notification_preferences (if missing)
ALTER TABLE user_notification_preferences
  ADD COLUMN IF NOT EXISTS health_notifications BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS social_notifications BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS system_notifications BOOLEAN NOT NULL DEFAULT true;

-- 3. Supabase Realtime on user_notifications — already enabled in v1 migration

-- 4. Index on type for dedup queries (e.g. welcome_to_vitana check)
CREATE INDEX IF NOT EXISTS idx_user_notifications_type
  ON user_notifications (user_id, type);
