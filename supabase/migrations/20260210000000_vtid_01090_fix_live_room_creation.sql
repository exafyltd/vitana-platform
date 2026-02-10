-- VTID-01090: Fix Live Room Creation - Add access_level and metadata
-- Date: 2026-02-10
-- Fixes: "Access Denied" error when creating paid live rooms

-- ============================================================================
-- Add missing columns to live_rooms table
-- ============================================================================

ALTER TABLE live_rooms
  ADD COLUMN IF NOT EXISTS access_level TEXT DEFAULT 'public' CHECK (access_level IN ('public', 'group')),
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN live_rooms.access_level IS 'Room access level: public (free) or group (paid)';
COMMENT ON COLUMN live_rooms.metadata IS 'Room metadata including price, description, etc.';

-- ============================================================================
-- Update live_room_create RPC to accept access_level and metadata
-- ============================================================================

CREATE OR REPLACE FUNCTION live_room_create(p_payload JSONB)
RETURNS TABLE (
  id UUID,
  title TEXT,
  description TEXT,
  creator_user_id UUID,
  tenant_id UUID,
  access_level TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_user_id UUID;
BEGIN
  -- Get user ID from JWT
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Get tenant ID from JWT or use current_tenant_id()
  v_tenant_id := current_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant context required';
  END IF;

  -- Insert and return
  RETURN QUERY
  INSERT INTO live_rooms (
    title,
    description,
    creator_user_id,
    tenant_id,
    access_level,
    metadata
  ) VALUES (
    p_payload->>'title',
    p_payload->>'description',
    v_user_id,  -- Use JWT user ID
    v_tenant_id,
    COALESCE(p_payload->>'access_level', 'public'),
    COALESCE((p_payload->>'metadata')::JSONB, '{}'::jsonb)
  )
  RETURNING
    live_rooms.id,
    live_rooms.title,
    live_rooms.description,
    live_rooms.creator_user_id,
    live_rooms.tenant_id,
    live_rooms.access_level,
    live_rooms.metadata,
    live_rooms.created_at;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION live_room_create(JSONB) TO authenticated;
