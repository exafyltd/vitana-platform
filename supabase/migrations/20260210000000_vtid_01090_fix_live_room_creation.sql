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

CREATE OR REPLACE FUNCTION public.live_room_create(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_title TEXT;
    v_topic_keys TEXT[];
    v_starts_at TIMESTAMPTZ;
    v_access_level TEXT;
    v_metadata JSONB;
    v_room_id UUID;
BEGIN
    -- Get context
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Extract payload
    v_title := p_payload->>'title';
    v_topic_keys := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'topic_keys', '[]'::JSONB)));
    v_starts_at := COALESCE((p_payload->>'starts_at')::TIMESTAMPTZ, NOW());
    v_access_level := COALESCE(p_payload->>'access_level', 'public');
    v_metadata := COALESCE(p_payload->'metadata', '{}'::JSONB);

    IF v_title IS NULL OR v_title = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_TITLE', 'message', 'title is required');
    END IF;

    -- Create room
    INSERT INTO public.live_rooms (
        tenant_id,
        title,
        topic_keys,
        host_user_id,
        starts_at,
        access_level,
        metadata
    )
    VALUES (
        v_tenant_id,
        v_title,
        v_topic_keys,
        v_user_id,
        v_starts_at,
        v_access_level,
        v_metadata
    )
    RETURNING id INTO v_room_id;

    -- Create host edge (person -> live_room)
    PERFORM public.upsert_relationship_edge(
        v_tenant_id,
        'person',
        v_user_id,
        'live_room',
        v_room_id,
        'host',
        10,  -- Host gets +10 strength
        jsonb_build_object('created_at', NOW())
    );

    RETURN jsonb_build_object(
        'ok', true,
        'live_room_id', v_room_id,
        'title', v_title,
        'status', 'scheduled'
    );
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.live_room_create(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_create(JSONB) TO service_role;

COMMENT ON FUNCTION public.live_room_create IS 'VTID-01090-FIX: Create a new live room with access_level and metadata';
