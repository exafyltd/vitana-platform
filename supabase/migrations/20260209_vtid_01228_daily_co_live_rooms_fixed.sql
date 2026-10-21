-- ============================================================================
-- VTID-01228: Daily.co Video Integration for LIVE Rooms
-- UP Migration (FIXED for actual schema)
-- ============================================================================

-- 1. Add access_level column to live_rooms
ALTER TABLE live_rooms
ADD COLUMN IF NOT EXISTS access_level TEXT DEFAULT 'public'
  CHECK (access_level IN ('public', 'group'));

COMMENT ON COLUMN live_rooms.access_level IS
  'Access level: public (free) or group (paid)';

-- 2. Create access grants table
CREATE TABLE IF NOT EXISTS live_room_access_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,

  access_type TEXT NOT NULL CHECK (access_type IN ('owner', 'paid', 'free', 'granted')),

  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NULL,

  -- Revocation support
  is_valid BOOLEAN DEFAULT true,
  is_revoked BOOLEAN DEFAULT false,
  revoked_at TIMESTAMPTZ NULL,
  revoked_reason TEXT NULL,

  stripe_payment_intent_id TEXT NULL,
  refund_id TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::JSONB,

  UNIQUE (user_id, room_id)
);

COMMENT ON TABLE live_room_access_grants IS
  'Tracks user access to paid live rooms with revocation support';

-- 3. Add indexes
CREATE INDEX idx_access_grants_user ON live_room_access_grants(user_id);
CREATE INDEX idx_access_grants_room ON live_room_access_grants(room_id);
CREATE INDEX idx_access_grants_tenant ON live_room_access_grants(tenant_id);
CREATE INDEX idx_access_grants_payment ON live_room_access_grants(stripe_payment_intent_id);

-- Unique index for valid grants only
CREATE UNIQUE INDEX idx_access_grants_unique
  ON live_room_access_grants(user_id, room_id)
  WHERE is_valid = true AND is_revoked = false;

-- 4. RLS policies
ALTER TABLE live_room_access_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own access grants"
  ON live_room_access_grants FOR SELECT
  USING (
    tenant_id = (SELECT tenant_id FROM app_users WHERE user_id = auth.uid())
    AND user_id = auth.uid()
  );

CREATE POLICY "Prevent cross-tenant grant creation"
  ON live_room_access_grants FOR INSERT
  WITH CHECK (
    tenant_id = (SELECT tenant_id FROM app_users WHERE user_id = user_id)
    AND tenant_id = (SELECT tenant_id FROM live_rooms WHERE id = room_id)
  );

-- 5. Create public view to hide sensitive metadata (daily_room_url)
CREATE OR REPLACE VIEW live_rooms_public AS
SELECT
  id, tenant_id, title, topic_keys, host_user_id,
  starts_at, ends_at, status, created_at, updated_at,
  access_level, -- Expose access_level
  -- Filter metadata to exclude daily_room_url
  jsonb_build_object(
    'price', metadata->'price',
    'stream_type', metadata->'stream_type',
    'enable_replay', metadata->'enable_replay',
    'cover_image_url', metadata->'cover_image_url'
    -- Explicitly EXCLUDE daily_room_url, daily_room_name
  ) as metadata
FROM live_rooms;

COMMENT ON VIEW live_rooms_public IS
  'Public view of live_rooms without sensitive Daily.co room URL data';

-- 6. RPC: Check if user has access to room (3-parameter version with tenant)
CREATE OR REPLACE FUNCTION live_room_check_access(
  p_user_id UUID,
  p_room_id UUID,
  p_tenant_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
  v_room_tenant_id UUID;
  v_user_tenant_id UUID;
BEGIN
  -- Verify room belongs to tenant
  SELECT tenant_id INTO v_room_tenant_id
  FROM live_rooms WHERE id = p_room_id;

  IF v_room_tenant_id != p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: Room % not in tenant %', p_room_id, p_tenant_id;
  END IF;

  -- Verify user belongs to tenant
  SELECT tenant_id INTO v_user_tenant_id
  FROM app_users WHERE user_id = p_user_id;

  IF v_user_tenant_id != p_tenant_id THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: User % not in tenant %', p_user_id, p_tenant_id;
  END IF;

  -- Check ownership
  IF EXISTS (
    SELECT 1 FROM live_rooms
    WHERE id = p_room_id
      AND host_user_id = p_user_id
      AND tenant_id = p_tenant_id
  ) THEN
    RETURN TRUE;
  END IF;

  -- Check valid, non-revoked grant
  RETURN EXISTS (
    SELECT 1 FROM live_room_access_grants
    WHERE user_id = p_user_id
      AND room_id = p_room_id
      AND tenant_id = p_tenant_id
      AND is_valid = true
      AND is_revoked = false
      AND (expires_at IS NULL OR expires_at > NOW())
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. RPC: Backward-compatible 2-parameter version
CREATE OR REPLACE FUNCTION live_room_check_access(
  p_user_id UUID,
  p_room_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  -- Derive tenant from user
  RETURN live_room_check_access(
    p_user_id,
    p_room_id,
    (SELECT tenant_id FROM app_users WHERE user_id = p_user_id)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. RPC: Grant access to user
CREATE OR REPLACE FUNCTION live_room_grant_access(
  p_user_id UUID,
  p_room_id UUID,
  p_access_type TEXT,
  p_stripe_payment_intent_id TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_tenant_id UUID;
  v_grant_id UUID;
BEGIN
  -- Get tenant_id from room
  SELECT tenant_id INTO v_tenant_id FROM live_rooms WHERE id = p_room_id;

  -- Create access grant (upsert)
  INSERT INTO live_room_access_grants (
    tenant_id, user_id, room_id, access_type, stripe_payment_intent_id,
    is_valid, is_revoked
  ) VALUES (
    v_tenant_id, p_user_id, p_room_id, p_access_type, p_stripe_payment_intent_id,
    true, false
  )
  ON CONFLICT (user_id, room_id)
  DO UPDATE SET
    access_type = EXCLUDED.access_type,
    stripe_payment_intent_id = COALESCE(EXCLUDED.stripe_payment_intent_id, live_room_access_grants.stripe_payment_intent_id),
    purchased_at = NOW(),
    is_valid = true,
    is_revoked = false
  RETURNING id INTO v_grant_id;

  RETURN v_grant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. RPC: Revoke access (for refunds)
CREATE OR REPLACE FUNCTION live_room_revoke_access(
  p_grant_id UUID,
  p_reason TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  UPDATE live_room_access_grants
  SET
    is_revoked = true,
    is_valid = false,
    revoked_at = NOW(),
    revoked_reason = p_reason
  WHERE id = p_grant_id;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10. RPC: Invalidate all grants for a room (cancellation)
CREATE OR REPLACE FUNCTION live_room_invalidate_all_grants(
  p_room_id UUID
) RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE live_room_access_grants
  SET is_valid = false
  WHERE room_id = p_room_id AND is_valid = true;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 11. RPC: Get room details (for ownership verification and metadata checks)
CREATE OR REPLACE FUNCTION live_room_get(
  p_live_room_id UUID
) RETURNS TABLE (
  id UUID,
  tenant_id UUID,
  title TEXT,
  topic_keys TEXT[],
  host_user_id UUID,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  status TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  access_level TEXT,
  metadata JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    lr.id,
    lr.tenant_id,
    lr.title,
    lr.topic_keys,
    lr.host_user_id,
    lr.starts_at,
    lr.ends_at,
    lr.status,
    lr.created_at,
    lr.updated_at,
    lr.access_level,
    lr.metadata
  FROM live_rooms lr
  WHERE lr.id = p_live_room_id
    -- RLS: User must be in same tenant
    AND lr.tenant_id = (SELECT tenant_id FROM app_users WHERE user_id = auth.uid());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12. RPC: Update room metadata (for Daily.co room URL storage)
CREATE OR REPLACE FUNCTION live_room_update_metadata(
  p_live_room_id UUID,
  p_metadata JSONB
) RETURNS BOOLEAN AS $$
BEGIN
  UPDATE live_rooms
  SET metadata = p_metadata, updated_at = NOW()
  WHERE id = p_live_room_id
    AND host_user_id = auth.uid(); -- Only owner

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 13. Log completion
DO $$
BEGIN
  RAISE NOTICE 'VTID-01228: Daily.co Live Rooms integration schema created successfully';
END $$;
