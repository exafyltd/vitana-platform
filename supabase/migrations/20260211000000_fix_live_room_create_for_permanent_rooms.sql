-- =============================================================================
-- Fix live_room_create RPC for Permanent Rooms
-- =============================================================================
-- Issue: live_room_create RPC was defaulting starts_at to NOW() and hardcoding
-- status='scheduled', making it impossible to create permanent rooms with status='idle'.
--
-- Root cause analysis:
-- 1. Line 51: v_starts_at := COALESCE((p_payload->>'starts_at')::TIMESTAMPTZ, NOW());
--    - This defaults starts_at to NOW() when not provided
-- 2. Line 96: Returns hardcoded 'status', 'scheduled'
-- 3. Table insert doesn't explicitly set status, relies on table default
--
-- Fix:
-- 1. Make starts_at nullable (don't default to NOW())
-- 2. Set status based on whether starts_at is provided:
--    - If starts_at IS NULL → status='idle' (permanent room)
--    - If starts_at IS NOT NULL → status='scheduled' (scheduled room)
-- 3. ALTER TABLE to make starts_at nullable (required for permanent rooms)
-- =============================================================================

BEGIN;

-- First, make starts_at nullable on live_rooms table
-- (It was NOT NULL in original schema, but permanent rooms need starts_at=NULL)
ALTER TABLE public.live_rooms ALTER COLUMN starts_at DROP NOT NULL;

COMMENT ON COLUMN public.live_rooms.starts_at IS
  'Start time for scheduled rooms. NULL for permanent rooms (status=idle).';

-- Now fix the live_room_create RPC
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
    v_status TEXT;
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

    -- CRITICAL FIX: Don't default starts_at to NOW() — allow NULL for permanent rooms
    v_starts_at := (p_payload->>'starts_at')::TIMESTAMPTZ;

    v_access_level := COALESCE(p_payload->>'access_level', 'public');
    v_metadata := COALESCE(p_payload->'metadata', '{}'::JSONB);

    IF v_title IS NULL OR v_title = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_TITLE', 'message', 'title is required');
    END IF;

    -- Determine status based on starts_at
    -- NULL starts_at = permanent room (idle)
    -- Non-null starts_at = scheduled room (scheduled)
    IF v_starts_at IS NULL THEN
        v_status := 'idle';
    ELSE
        v_status := 'scheduled';
    END IF;

    -- Create room
    INSERT INTO public.live_rooms (
        tenant_id,
        title,
        topic_keys,
        host_user_id,
        starts_at,
        status,
        access_level,
        metadata
    )
    VALUES (
        v_tenant_id,
        v_title,
        v_topic_keys,
        v_user_id,
        v_starts_at,
        v_status,  -- CRITICAL: Set based on starts_at presence
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

    -- Link permanent room to user profile
    -- (Only for permanent rooms - idle status)
    IF v_status = 'idle' THEN
        UPDATE public.app_users
        SET live_room_id = v_room_id
        WHERE user_id = v_user_id AND tenant_id = v_tenant_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'live_room_id', v_room_id,
        'tenant_id', v_tenant_id,
        'host_user_id', v_user_id,
        'title', v_title,
        'status', v_status  -- CRITICAL: Return actual status, not hardcoded
    );
END;
$$;

COMMENT ON FUNCTION public.live_room_create IS
  'VTID-01228-FIX: Create either a permanent room (no starts_at, status=idle) or scheduled room (with starts_at, status=scheduled)';

COMMIT;
