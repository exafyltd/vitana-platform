-- =============================================================================
-- Social Connections for Profile Enrichment
-- VTID: VTID-01250 (AP-1305, AP-1306)
--
-- Stores OAuth tokens for connected social accounts and tracks
-- auto-share preferences per user.
-- =============================================================================

-- Social account connections
CREATE TABLE IF NOT EXISTS social_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN (
    'instagram', 'facebook', 'tiktok', 'youtube', 'linkedin', 'twitter'
  )),
  provider_user_id TEXT,
  provider_username TEXT,
  display_name TEXT,
  avatar_url TEXT,
  profile_url TEXT,
  access_token TEXT,            -- encrypted at rest by Supabase
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scopes TEXT[],                -- granted OAuth scopes
  profile_data JSONB DEFAULT '{}'::jsonb,  -- scraped profile info (bio, followers, etc.)
  enrichment_status TEXT DEFAULT 'pending' CHECK (enrichment_status IN (
    'pending', 'enriching', 'completed', 'failed', 'skipped'
  )),
  enrichment_data JSONB DEFAULT '{}'::jsonb,  -- extracted data used to enrich Vitana profile
  last_enriched_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE (tenant_id, user_id, provider)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_social_connections_user
  ON social_connections (user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_social_connections_enrichment
  ON social_connections (enrichment_status) WHERE is_active = true;

-- Auto-share preferences (extends autopilot_prompt_prefs)
-- Stored separately to keep social sharing concerns isolated
CREATE TABLE IF NOT EXISTS social_share_prefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  auto_share_enabled BOOLEAN DEFAULT true,
  share_milestones BOOLEAN DEFAULT true,
  share_to_providers TEXT[] DEFAULT ARRAY['instagram', 'facebook', 'linkedin']::TEXT[],
  share_visibility TEXT DEFAULT 'public' CHECK (share_visibility IN ('public', 'connections', 'private')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE (tenant_id, user_id)
);

-- Social share log (tracks what was shared where)
CREATE TABLE IF NOT EXISTS social_share_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  provider TEXT NOT NULL,
  share_type TEXT NOT NULL CHECK (share_type IN ('milestone', 'event', 'group', 'achievement')),
  content_ref TEXT,              -- milestone_id, event_id, etc.
  share_url TEXT,
  share_status TEXT DEFAULT 'pending' CHECK (share_status IN (
    'pending', 'posted', 'failed', 'cancelled'
  )),
  error_message TEXT,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_share_log_user
  ON social_share_log (user_id, created_at DESC);

-- RLS policies
ALTER TABLE social_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_share_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_share_log ENABLE ROW LEVEL SECURITY;

-- Users can read/write their own connections
CREATE POLICY social_connections_user_policy ON social_connections
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY social_share_prefs_user_policy ON social_share_prefs
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY social_share_log_user_policy ON social_share_log
  FOR ALL USING (auth.uid() = user_id);

-- Service role bypass
CREATE POLICY social_connections_service ON social_connections
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY social_share_prefs_service ON social_share_prefs
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY social_share_log_service ON social_share_log
  FOR ALL USING (auth.role() = 'service_role');
