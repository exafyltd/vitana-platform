-- =============================================================================
-- Notification Category Management — Dynamic Categories + User Preferences
-- =============================================================================
-- Adds admin-managed notification categories grouped by type (chat, calendar,
-- community) and per-user toggle preferences for each category.
-- Existing user_notification_preferences table is untouched (global push toggle
-- and DND settings continue to live there).
-- =============================================================================

-- 1. Admin-managed notification categories
CREATE TABLE IF NOT EXISTS notification_categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID,                        -- NULL = global (all tenants)
  type            TEXT NOT NULL CHECK (type IN ('chat', 'calendar', 'community')),
  slug            TEXT NOT NULL,                -- machine key, e.g. 'direct_messages'
  display_name    TEXT NOT NULL,                -- human label, e.g. 'Direct Messages'
  description     TEXT,                         -- brief explanation for settings UI
  icon            TEXT,                         -- optional lucide icon name
  sort_order      INTEGER NOT NULL DEFAULT 0,   -- display order within type
  is_active       BOOLEAN NOT NULL DEFAULT true,
  default_enabled BOOLEAN NOT NULL DEFAULT true, -- default for users without explicit preference
  mapped_types    JSONB NOT NULL DEFAULT '[]',   -- array of TYPE_META keys this category covers
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID
);

-- Unique slug per shared (global) categories
CREATE UNIQUE INDEX notification_categories_slug_shared_uq
  ON notification_categories (slug) WHERE tenant_id IS NULL;

-- Unique slug per tenant-specific categories
CREATE UNIQUE INDEX notification_categories_slug_tenant_uq
  ON notification_categories (slug, tenant_id) WHERE tenant_id IS NOT NULL;

-- Index for lookups by type
CREATE INDEX idx_notification_categories_type
  ON notification_categories (type, sort_order);

-- Index for mapped_types containment queries (used by notification dispatch)
CREATE INDEX idx_notification_categories_mapped_types
  ON notification_categories USING gin (mapped_types);

-- 2. Per-user toggle per category
CREATE TABLE IF NOT EXISTS user_category_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  tenant_id   UUID NOT NULL,
  category_id UUID NOT NULL REFERENCES notification_categories(id) ON DELETE CASCADE,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, category_id)
);

CREATE INDEX idx_user_category_preferences_user
  ON user_category_preferences (user_id, tenant_id);

-- 3. RLS Policies

ALTER TABLE notification_categories ENABLE ROW LEVEL SECURITY;

-- Service-role full access (admin API is the gatekeeper)
CREATE POLICY "service_role_full_access_categories"
  ON notification_categories FOR ALL
  USING (true) WITH CHECK (true);

-- Authenticated users can read active categories
CREATE POLICY "authenticated_read_active_categories"
  ON notification_categories FOR SELECT TO authenticated
  USING (is_active = true);

ALTER TABLE user_category_preferences ENABLE ROW LEVEL SECURITY;

-- Users manage their own category preferences
CREATE POLICY "users_manage_own_category_prefs"
  ON user_category_preferences FOR ALL
  USING (auth.uid() = user_id);

-- Service-role full access for admin stats queries
CREATE POLICY "service_role_full_access_category_prefs"
  ON user_category_preferences FOR ALL
  USING (true) WITH CHECK (true);
