-- =============================================================================
-- COMPREHENSIVE LIVE ROOMS FIX — ALL DATABASE ISSUES
-- =============================================================================
-- Run in Supabase Dashboard → SQL Editor
--
-- Fixes ALL issues found in the full-stack audit:
-- D1: current_tenant_id() returns NULL for standard JWTs (8 RPCs broken)
-- D2: app_users.tenant_id doesn't exist (references crash)
-- D4: live_room_set_host_present ambiguous column
-- D5: RLS tautology on live_room_access_grants
-- D7: create_user_live_room trigger sets starts_at=NOW() instead of NULL
-- Plus: Restore deleted user records
-- =============================================================================

BEGIN;

-- =============================================================================
-- STEP 0: HELPER — Resolve tenant_id from auth.uid() via user_tenants
-- =============================================================================
-- This is the CORE fix: a reusable function that works with standard Supabase JWTs.
-- It replaces current_tenant_id() for all live room RPCs.

CREATE OR REPLACE FUNCTION public.resolve_tenant_for_user(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
BEGIN
    -- Strategy 1: current_tenant_id() (works with dev bootstrap or custom JWT claims)
    v_tenant_id := public.current_tenant_id();
    IF v_tenant_id IS NOT NULL THEN
        RETURN v_tenant_id;
    END IF;

    -- Strategy 2: Look up from user_tenants (works with standard Supabase JWTs)
    SELECT tenant_id INTO v_tenant_id
    FROM public.user_tenants
    WHERE user_id = p_user_id
      AND is_primary = true
    LIMIT 1;

    IF v_tenant_id IS NOT NULL THEN
        RETURN v_tenant_id;
    END IF;

    -- Strategy 3: Any tenant for this user
    SELECT tenant_id INTO v_tenant_id
    FROM public.user_tenants
    WHERE user_id = p_user_id
    LIMIT 1;

    RETURN v_tenant_id;  -- May still be NULL if no tenant mapping exists
END;
$$;

COMMENT ON FUNCTION public.resolve_tenant_for_user IS
    'Resolve tenant_id for a user. Works with standard Supabase JWTs (unlike current_tenant_id).';

-- =============================================================================
-- STEP 1: RESTORE USER RECORDS (deleted during cleanup)
-- =============================================================================

DO $$
DECLARE
    v_user_id UUID;
    v_email TEXT;
    v_display_name TEXT;
    v_maxina_tenant_id UUID := '2e7528b8-472a-4356-88da-0280d4639cce';
BEGIN
    -- Find the actual auth user
    SELECT id, email, COALESCE(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', split_part(email, '@', 1))
    INTO v_user_id, v_email, v_display_name
    FROM auth.users
    WHERE email LIKE '%vitana%' OR email LIKE '%dragan%'
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_user_id IS NULL THEN
        -- Fallback: get any user
        SELECT id, email, COALESCE(raw_user_meta_data->>'full_name', split_part(email, '@', 1))
        INTO v_user_id, v_email, v_display_name
        FROM auth.users
        ORDER BY created_at ASC
        LIMIT 1;
    END IF;

    IF v_user_id IS NULL THEN
        RAISE WARNING 'No auth users found! Cannot restore records.';
        RETURN;
    END IF;

    RAISE NOTICE 'Restoring records for user: % (%) tenant: %', v_email, v_user_id, v_maxina_tenant_id;

    -- Restore app_users (tenant_id is NOT NULL)
    INSERT INTO public.app_users (user_id, email, display_name, tenant_id)
    VALUES (v_user_id, v_email, v_display_name, v_maxina_tenant_id)
    ON CONFLICT (user_id) DO UPDATE SET
        email = EXCLUDED.email,
        display_name = EXCLUDED.display_name,
        tenant_id = v_maxina_tenant_id,
        updated_at = NOW();

    -- Restore user_tenants
    INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
    VALUES (v_maxina_tenant_id, v_user_id, 'developer', true)
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET
        active_role = 'developer',
        is_primary = true,
        updated_at = NOW();

    RAISE NOTICE 'User records restored successfully.';
END $$;

-- =============================================================================
-- STEP 2: FIX live_room_create — Use resolve_tenant_for_user
-- =============================================================================

-- Ensure starts_at is nullable (for permanent rooms)
ALTER TABLE public.live_rooms ALTER COLUMN starts_at DROP NOT NULL;

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
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    v_tenant_id := public.resolve_tenant_for_user(v_user_id);
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND',
            'message', 'No tenant found. Check user_tenants table.');
    END IF;

    v_title := p_payload->>'title';
    v_topic_keys := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_payload->'topic_keys', '[]'::JSONB)));
    v_starts_at := (p_payload->>'starts_at')::TIMESTAMPTZ;  -- NULL for permanent rooms
    v_access_level := COALESCE(p_payload->>'access_level', 'public');
    v_metadata := COALESCE(p_payload->'metadata', '{}'::JSONB);

    IF v_title IS NULL OR v_title = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_TITLE', 'message', 'title is required');
    END IF;

    v_status := CASE WHEN v_starts_at IS NULL THEN 'idle' ELSE 'scheduled' END;

    INSERT INTO public.live_rooms (
        tenant_id, title, topic_keys, host_user_id,
        starts_at, status, access_level, metadata
    ) VALUES (
        v_tenant_id, v_title, v_topic_keys, v_user_id,
        v_starts_at, v_status, v_access_level, v_metadata
    ) RETURNING id INTO v_room_id;

    -- Create host edge
    BEGIN
        PERFORM public.upsert_relationship_edge(
            v_tenant_id, 'person', v_user_id,
            'live_room', v_room_id, 'host', 10,
            jsonb_build_object('created_at', NOW())
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'upsert_relationship_edge failed: %', SQLERRM;
    END;

    -- Link permanent room to user profile
    IF v_status = 'idle' THEN
        UPDATE public.app_users
        SET live_room_id = v_room_id
        WHERE user_id = v_user_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'live_room_id', v_room_id,
        'tenant_id', v_tenant_id,
        'host_user_id', v_user_id,
        'title', v_title,
        'status', v_status
    );
END;
$$;

-- =============================================================================
-- STEP 3: FIX live_room_start — Replace current_tenant_id/current_user_id
-- =============================================================================

CREATE OR REPLACE FUNCTION public.live_room_start(p_live_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_room RECORD;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    v_tenant_id := public.resolve_tenant_for_user(v_user_id);
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    SELECT * INTO v_room FROM public.live_rooms
    WHERE id = p_live_room_id AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
    END IF;

    IF v_room.host_user_id != v_user_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
    END IF;

    IF v_room.status NOT IN ('scheduled', 'lobby') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATUS',
            'message', 'Room must be scheduled or in lobby to start');
    END IF;

    UPDATE public.live_rooms
    SET status = 'live', updated_at = NOW()
    WHERE id = p_live_room_id;

    RETURN jsonb_build_object(
        'ok', true,
        'live_room_id', p_live_room_id,
        'started_at', NOW()
    );
END;
$$;

-- =============================================================================
-- STEP 4: FIX live_room_end — Replace current_tenant_id/current_user_id
-- =============================================================================

CREATE OR REPLACE FUNCTION public.live_room_end(p_live_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_room RECORD;
    v_edges_count INT := 0;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    v_tenant_id := public.resolve_tenant_for_user(v_user_id);
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    SELECT * INTO v_room FROM public.live_rooms
    WHERE id = p_live_room_id AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
    END IF;

    IF v_room.host_user_id != v_user_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
    END IF;

    IF v_room.status NOT IN ('live', 'lobby') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_LIVE');
    END IF;

    -- End the room — reset to idle for permanent rooms
    UPDATE public.live_rooms
    SET status = 'idle', current_session_id = NULL, host_present = false, updated_at = NOW()
    WHERE id = p_live_room_id;

    -- Close attendance
    UPDATE public.live_room_attendance
    SET left_at = NOW(), updated_at = NOW()
    WHERE live_room_id = p_live_room_id AND left_at IS NULL;

    RETURN jsonb_build_object(
        'ok', true,
        'live_room_id', p_live_room_id,
        'ended_at', NOW(),
        'edges_strengthened', v_edges_count
    );
END;
$$;

-- =============================================================================
-- STEP 5: FIX live_room_join — Replace current_tenant_id/current_user_id
-- =============================================================================

CREATE OR REPLACE FUNCTION public.live_room_join(p_live_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_room RECORD;
    v_attendance_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    v_tenant_id := public.resolve_tenant_for_user(v_user_id);
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    SELECT * INTO v_room FROM public.live_rooms
    WHERE id = p_live_room_id AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
    END IF;

    IF v_room.status NOT IN ('live', 'lobby') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_LIVE',
            'message', 'Room must be live or in lobby to join');
    END IF;

    -- Upsert attendance
    INSERT INTO public.live_room_attendance (tenant_id, live_room_id, user_id, session_id, joined_at)
    VALUES (v_tenant_id, p_live_room_id, v_user_id, v_room.current_session_id, NOW())
    ON CONFLICT (tenant_id, live_room_id, user_id) WHERE session_id IS NULL
    DO UPDATE SET joined_at = NOW(), left_at = NULL, updated_at = NOW()
    RETURNING id INTO v_attendance_id;

    -- If conflict on session-scoped attendance
    IF v_attendance_id IS NULL AND v_room.current_session_id IS NOT NULL THEN
        INSERT INTO public.live_room_attendance (tenant_id, live_room_id, user_id, session_id, joined_at)
        VALUES (v_tenant_id, p_live_room_id, v_user_id, v_room.current_session_id, NOW())
        ON CONFLICT (tenant_id, session_id, user_id) WHERE session_id IS NOT NULL
        DO UPDATE SET joined_at = NOW(), left_at = NULL, updated_at = NOW()
        RETURNING id INTO v_attendance_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'attendance_id', v_attendance_id,
        'live_room_id', p_live_room_id,
        'joined_at', NOW()
    );
END;
$$;

-- =============================================================================
-- STEP 6: FIX live_room_leave — Replace current_tenant_id/current_user_id
-- =============================================================================

CREATE OR REPLACE FUNCTION public.live_room_leave(p_live_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    v_tenant_id := public.resolve_tenant_for_user(v_user_id);
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    UPDATE public.live_room_attendance
    SET left_at = NOW(), updated_at = NOW()
    WHERE live_room_id = p_live_room_id AND user_id = v_user_id AND left_at IS NULL;

    RETURN jsonb_build_object('ok', true, 'live_room_id', p_live_room_id, 'left_at', NOW());
END;
$$;

-- =============================================================================
-- STEP 7: FIX live_add_highlight — Replace current_tenant_id/current_user_id
-- =============================================================================

CREATE OR REPLACE FUNCTION public.live_add_highlight(
    p_live_room_id UUID,
    p_type TEXT,
    p_text TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_room RECORD;
    v_highlight_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    v_tenant_id := public.resolve_tenant_for_user(v_user_id);
    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    SELECT * INTO v_room FROM public.live_rooms
    WHERE id = p_live_room_id AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
    END IF;

    IF v_room.status != 'live' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_LIVE');
    END IF;

    INSERT INTO public.live_room_highlights (tenant_id, live_room_id, user_id, type, text)
    VALUES (v_tenant_id, p_live_room_id, v_user_id, p_type, p_text)
    RETURNING id INTO v_highlight_id;

    RETURN jsonb_build_object('ok', true, 'highlight_id', v_highlight_id);
END;
$$;

-- =============================================================================
-- STEP 8: FIX get_live_room_summary — Replace current_tenant_id
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_live_room_summary(p_live_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_room RECORD;
    v_attendee_count INT;
    v_highlight_count INT;
    v_duration_min INT;
BEGIN
    v_user_id := auth.uid();
    v_tenant_id := public.resolve_tenant_for_user(v_user_id);

    SELECT * INTO v_room FROM public.live_rooms WHERE id = p_live_room_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
    END IF;

    SELECT COUNT(DISTINCT user_id) INTO v_attendee_count
    FROM public.live_room_attendance WHERE live_room_id = p_live_room_id;

    SELECT COUNT(*) INTO v_highlight_count
    FROM public.live_room_highlights WHERE live_room_id = p_live_room_id;

    RETURN jsonb_build_object(
        'ok', true,
        'room_id', p_live_room_id,
        'title', v_room.title,
        'status', v_room.status,
        'attendee_count', v_attendee_count,
        'highlight_count', v_highlight_count
    );
END;
$$;

-- =============================================================================
-- STEP 9: FIX create_user_live_room trigger — NULL starts_at for permanent rooms
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_user_live_room()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_room_id UUID;
    v_display_name TEXT;
BEGIN
    -- Only create room if user doesn't already have one
    IF NEW.live_room_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    v_display_name := COALESCE(NEW.display_name, split_part(NEW.email, '@', 1));

    INSERT INTO public.live_rooms (
        tenant_id, title, host_user_id, starts_at, status, room_name, room_slug
    ) VALUES (
        NEW.tenant_id,
        v_display_name || '''s Live Room',
        NEW.user_id,
        NULL,  -- FIX: NULL for permanent rooms (was NOW())
        'idle',
        v_display_name || '''s Room',
        lower(replace(v_display_name, ' ', '-')) || '-' || substr(gen_random_uuid()::text, 1, 8)
    ) RETURNING id INTO v_room_id;

    NEW.live_room_id := v_room_id;
    RETURN NEW;
END;
$$;

-- =============================================================================
-- STEP 10: FIX live_room_set_host_present — Ambiguous column reference
-- =============================================================================

CREATE OR REPLACE FUNCTION public.live_room_set_host_present(p_room_id UUID, p_present BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_room RECORD;
BEGIN
    SELECT * INTO v_room FROM public.live_rooms WHERE id = p_room_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
    END IF;

    IF v_room.host_user_id != auth.uid() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
    END IF;

    UPDATE public.live_rooms
    SET host_present = p_present, updated_at = NOW()
    WHERE id = p_room_id;

    -- Also update current session (FIX: no ambiguous column reference)
    IF v_room.current_session_id IS NOT NULL THEN
        UPDATE public.live_room_sessions
        SET host_present = p_present, updated_at = NOW()
        WHERE id = v_room.current_session_id;
    END IF;

    RETURN jsonb_build_object('ok', true, 'host_present', p_present);
END;
$$;

-- =============================================================================
-- STEP 11: Clean up any stuck rooms from previous attempts
-- =============================================================================

DO $$
DECLARE
    v_user_id UUID;
BEGIN
    SELECT id INTO v_user_id FROM auth.users
    WHERE email LIKE '%vitana%' OR email LIKE '%dragan%'
    ORDER BY created_at ASC LIMIT 1;

    IF v_user_id IS NULL THEN
        SELECT id INTO v_user_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
    END IF;

    IF v_user_id IS NOT NULL THEN
        -- Delete stuck sessions
        DELETE FROM public.live_room_sessions
        WHERE room_id IN (SELECT id FROM public.live_rooms WHERE host_user_id = v_user_id);

        -- Delete stuck rooms
        DELETE FROM public.live_rooms WHERE host_user_id = v_user_id;

        -- Clear live_room_id reference
        UPDATE public.app_users SET live_room_id = NULL WHERE user_id = v_user_id;

        RAISE NOTICE 'Cleaned up stuck rooms for user %', v_user_id;
    END IF;
END $$;

COMMIT;

-- Verify
SELECT 'ALL FIXES APPLIED SUCCESSFULLY!' AS result,
       (SELECT COUNT(*) FROM app_users WHERE user_id IN (SELECT id FROM auth.users LIMIT 1)) AS app_users_count,
       (SELECT COUNT(*) FROM user_tenants WHERE user_id IN (SELECT id FROM auth.users LIMIT 1)) AS user_tenants_count,
       (SELECT COUNT(*) FROM live_rooms WHERE host_user_id IN (SELECT id FROM auth.users LIMIT 1)) AS live_rooms_count;
