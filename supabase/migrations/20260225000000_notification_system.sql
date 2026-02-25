-- =============================================================================
-- Notification System — FCM Device Tokens + Notification History
-- =============================================================================

-- 1. Device tokens for Firebase Cloud Messaging push notifications
CREATE TABLE IF NOT EXISTS user_device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  fcm_token TEXT NOT NULL,
  device_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, fcm_token)
);

ALTER TABLE user_device_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_tokens"
  ON user_device_tokens FOR ALL
  USING (auth.uid() = user_id);

-- 2. Notification log — in-app history + read tracking
CREATE TABLE IF NOT EXISTS user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  type TEXT NOT NULL,        -- e.g. 'live_room_starting', 'new_match', 'task_completed'
  title TEXT NOT NULL,
  body TEXT,
  data JSONB DEFAULT '{}',   -- deep-link URL, entity IDs, etc.
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_see_own_notifications"
  ON user_notifications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_mark_own_read"
  ON user_notifications FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_user_notifications_user_time
  ON user_notifications (user_id, tenant_id, created_at DESC);

CREATE INDEX idx_user_notifications_unread
  ON user_notifications (user_id)
  WHERE read_at IS NULL;

-- 3. Notification preferences (per-user opt-in/out + muted threads)
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id UUID PRIMARY KEY,
  tenant_id UUID,
  push_enabled BOOLEAN NOT NULL DEFAULT true,
  live_room_notifications BOOLEAN NOT NULL DEFAULT true,
  match_notifications BOOLEAN NOT NULL DEFAULT true,
  recommendation_notifications BOOLEAN NOT NULL DEFAULT true,
  task_notifications BOOLEAN NOT NULL DEFAULT true,
  community_notifications BOOLEAN NOT NULL DEFAULT true,
  memory_notifications BOOLEAN NOT NULL DEFAULT false,
  muted_threads TEXT[] DEFAULT '{}',
  dnd_enabled BOOLEAN NOT NULL DEFAULT false,
  dnd_start_time TIME,
  dnd_end_time TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_prefs"
  ON user_notification_preferences FOR ALL
  USING (auth.uid() = user_id);

-- Service-role insert policy (gateway writes tokens on behalf of users)
CREATE POLICY "service_role_manage_tokens"
  ON user_device_tokens FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "service_role_insert_notifications"
  ON user_notifications FOR INSERT
  WITH CHECK (true);
