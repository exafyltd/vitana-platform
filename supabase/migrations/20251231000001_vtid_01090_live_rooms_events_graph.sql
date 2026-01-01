-- Migration: 20251231000001_vtid_01090_live_rooms_events_graph.sql
-- Purpose: VTID-01090 Live Rooms + Events as Relationship Nodes (Attendance -> Graph Strengthening)
-- Date: 2025-12-31
--
-- Creates the live room and event attendance infrastructure with relationship graph integration:
--   - relationship_edges: Core graph for person/event/group connections (from VTID-01087)
--   - live_rooms: Live discussion rooms with host, topics, and scheduling
--   - live_room_attendance: User attendance tracking for live rooms
--   - event_attendance: RSVP and attendance tracking for meetups
--   - live_highlights: Notable moments captured during live rooms
--
-- Relationship Graph Integration:
--   - Attending events/rooms strengthens edges between users, events, and groups
--   - Co-attendance creates weak person<->person edges
--   - Deterministic strength increments (no LLM, no randomness)
--
-- Strength Increments (fixed constants):
--   - RSVP: +5
--   - Attended: +15
--   - Stayed > 20 min in live room: +10
--   - Created highlight: +8
--   - Co-attendance with same person: +3 (capped per day)
--
-- Dependencies:
--   - VTID-01101 (Phase A-Fix) - tenant/user/role helpers
--   - VTID-01084 (Community Meetups) - meetups table

-- ===========================================================================
-- EDGE STRENGTH CONSTANTS
-- ===========================================================================
-- These are platform-invariant constants used throughout the module
-- DO NOT CHANGE without governance approval

DO $$
BEGIN
    -- Define edge strength constants as GUCs for this transaction
    PERFORM set_config('vtid01090.strength_rsvp', '5', true);
    PERFORM set_config('vtid01090.strength_attended', '15', true);
    PERFORM set_config('vtid01090.strength_stayed_20min', '10', true);
    PERFORM set_config('vtid01090.strength_highlight', '8', true);
    PERFORM set_config('vtid01090.strength_coattendance', '3', true);
    PERFORM set_config('vtid01090.coattendance_daily_cap', '15', true);
END $$;

-- ===========================================================================
-- 1. RELATIONSHIP_EDGES TABLE (Core Graph - VTID-01087 implementation)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.relationship_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('person', 'event', 'live_room', 'group', 'meetup')),
    source_id UUID NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('person', 'event', 'live_room', 'group', 'meetup')),
    target_id UUID NOT NULL,
    edge_type TEXT NOT NULL CHECK (edge_type IN ('attendee', 'member', 'host', 'coattendance', 'organizer')),
    strength INT NOT NULL DEFAULT 0 CHECK (strength >= 0 AND strength <= 1000),
    last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::JSONB,
    UNIQUE (tenant_id, source_type, source_id, target_type, target_id, edge_type)
);

-- Indexes for efficient graph traversal
CREATE INDEX IF NOT EXISTS idx_relationship_edges_tenant_source
    ON public.relationship_edges (tenant_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_tenant_target
    ON public.relationship_edges (tenant_id, target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_tenant_strength
    ON public.relationship_edges (tenant_id, strength DESC);

CREATE INDEX IF NOT EXISTS idx_relationship_edges_last_interaction
    ON public.relationship_edges (tenant_id, last_interaction_at DESC);

-- RLS
ALTER TABLE public.relationship_edges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS relationship_edges_select ON public.relationship_edges;
CREATE POLICY relationship_edges_select ON public.relationship_edges
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS relationship_edges_service_role ON public.relationship_edges;
CREATE POLICY relationship_edges_service_role ON public.relationship_edges
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE public.relationship_edges IS 'VTID-01090/VTID-01087: Core relationship graph for person/event/group connections';

-- ===========================================================================
-- 2. LIVE_ROOMS TABLE
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.live_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    title TEXT NOT NULL CHECK (title != ''),
    topic_keys TEXT[] DEFAULT '{}',
    host_user_id UUID NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NULL,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::JSONB
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_live_rooms_tenant_status
    ON public.live_rooms (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_live_rooms_tenant_starts
    ON public.live_rooms (tenant_id, starts_at DESC);

CREATE INDEX IF NOT EXISTS idx_live_rooms_host
    ON public.live_rooms (tenant_id, host_user_id);

-- RLS
ALTER TABLE public.live_rooms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS live_rooms_select ON public.live_rooms;
CREATE POLICY live_rooms_select ON public.live_rooms
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS live_rooms_insert ON public.live_rooms;
CREATE POLICY live_rooms_insert ON public.live_rooms
    FOR INSERT
    TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS live_rooms_update ON public.live_rooms;
CREATE POLICY live_rooms_update ON public.live_rooms
    FOR UPDATE
    TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS live_rooms_service_role ON public.live_rooms;
CREATE POLICY live_rooms_service_role ON public.live_rooms
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE public.live_rooms IS 'VTID-01090: Live discussion rooms with host, topics, and scheduling';

-- ===========================================================================
-- 3. LIVE_ROOM_ATTENDANCE TABLE
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.live_room_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    live_room_id UUID NOT NULL REFERENCES public.live_rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ NULL,
    duration_minutes INT GENERATED ALWAYS AS (
        CASE
            WHEN left_at IS NOT NULL THEN EXTRACT(EPOCH FROM (left_at - joined_at)) / 60
            ELSE NULL
        END
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, live_room_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_live_room_attendance_tenant_room
    ON public.live_room_attendance (tenant_id, live_room_id);

CREATE INDEX IF NOT EXISTS idx_live_room_attendance_tenant_user
    ON public.live_room_attendance (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_live_room_attendance_joined
    ON public.live_room_attendance (tenant_id, joined_at DESC);

-- RLS
ALTER TABLE public.live_room_attendance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS live_room_attendance_select ON public.live_room_attendance;
CREATE POLICY live_room_attendance_select ON public.live_room_attendance
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS live_room_attendance_insert ON public.live_room_attendance;
CREATE POLICY live_room_attendance_insert ON public.live_room_attendance
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS live_room_attendance_update ON public.live_room_attendance;
CREATE POLICY live_room_attendance_update ON public.live_room_attendance
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS live_room_attendance_service_role ON public.live_room_attendance;
CREATE POLICY live_room_attendance_service_role ON public.live_room_attendance
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE public.live_room_attendance IS 'VTID-01090: User attendance tracking for live rooms with duration';

-- ===========================================================================
-- 4. EVENT_ATTENDANCE TABLE (for meetups)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.event_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    meetup_id UUID NOT NULL,  -- References meetups table (VTID-01084)
    user_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'rsvp' CHECK (status IN ('rsvp', 'attended', 'no_show')),
    rsvp_at TIMESTAMPTZ NULL,
    attended_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, meetup_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_event_attendance_tenant_meetup
    ON public.event_attendance (tenant_id, meetup_id);

CREATE INDEX IF NOT EXISTS idx_event_attendance_tenant_user
    ON public.event_attendance (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_event_attendance_status
    ON public.event_attendance (tenant_id, status);

-- RLS
ALTER TABLE public.event_attendance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_attendance_select ON public.event_attendance;
CREATE POLICY event_attendance_select ON public.event_attendance
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS event_attendance_insert ON public.event_attendance;
CREATE POLICY event_attendance_insert ON public.event_attendance
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS event_attendance_update ON public.event_attendance;
CREATE POLICY event_attendance_update ON public.event_attendance
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS event_attendance_service_role ON public.event_attendance;
CREATE POLICY event_attendance_service_role ON public.event_attendance
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE public.event_attendance IS 'VTID-01090: RSVP and attendance tracking for meetups';

-- ===========================================================================
-- 5. LIVE_HIGHLIGHTS TABLE
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.live_highlights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    live_room_id UUID NOT NULL REFERENCES public.live_rooms(id) ON DELETE CASCADE,
    created_by_user_id UUID NOT NULL,
    highlight_type TEXT NOT NULL CHECK (highlight_type IN ('quote', 'moment', 'action_item', 'insight')),
    text TEXT NOT NULL CHECK (text != ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::JSONB
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_live_highlights_tenant_room
    ON public.live_highlights (tenant_id, live_room_id);

CREATE INDEX IF NOT EXISTS idx_live_highlights_tenant_user
    ON public.live_highlights (tenant_id, created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_live_highlights_type
    ON public.live_highlights (tenant_id, highlight_type);

-- RLS
ALTER TABLE public.live_highlights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS live_highlights_select ON public.live_highlights;
CREATE POLICY live_highlights_select ON public.live_highlights
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS live_highlights_insert ON public.live_highlights;
CREATE POLICY live_highlights_insert ON public.live_highlights
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND created_by_user_id = public.current_user_id()
    );

DROP POLICY IF EXISTS live_highlights_service_role ON public.live_highlights;
CREATE POLICY live_highlights_service_role ON public.live_highlights
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE public.live_highlights IS 'VTID-01090: Notable moments captured during live rooms';

-- ===========================================================================
-- 6. HELPER FUNCTION: upsert_relationship_edge
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.upsert_relationship_edge(
    p_tenant_id UUID,
    p_source_type TEXT,
    p_source_id UUID,
    p_target_type TEXT,
    p_target_id UUID,
    p_edge_type TEXT,
    p_strength_delta INT,
    p_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_edge_id UUID;
    v_new_strength INT;
    v_old_strength INT;
BEGIN
    -- Cap strength delta at reasonable bounds
    IF p_strength_delta < 0 THEN
        p_strength_delta := 0;
    ELSIF p_strength_delta > 100 THEN
        p_strength_delta := 100;
    END IF;

    -- Upsert the edge
    INSERT INTO public.relationship_edges (
        tenant_id,
        source_type,
        source_id,
        target_type,
        target_id,
        edge_type,
        strength,
        last_interaction_at,
        metadata
    )
    VALUES (
        p_tenant_id,
        p_source_type,
        p_source_id,
        p_target_type,
        p_target_id,
        p_edge_type,
        LEAST(p_strength_delta, 1000),
        NOW(),
        p_metadata
    )
    ON CONFLICT (tenant_id, source_type, source_id, target_type, target_id, edge_type)
    DO UPDATE SET
        strength = LEAST(relationship_edges.strength + p_strength_delta, 1000),
        last_interaction_at = NOW(),
        updated_at = NOW(),
        metadata = relationship_edges.metadata || p_metadata
    RETURNING id, strength, strength - p_strength_delta INTO v_edge_id, v_new_strength, v_old_strength;

    RETURN jsonb_build_object(
        'ok', true,
        'edge_id', v_edge_id,
        'old_strength', COALESCE(v_old_strength, 0),
        'new_strength', v_new_strength,
        'delta', p_strength_delta
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_relationship_edge(UUID, TEXT, UUID, TEXT, UUID, TEXT, INT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_relationship_edge(UUID, TEXT, UUID, TEXT, UUID, TEXT, INT, JSONB) TO service_role;

COMMENT ON FUNCTION public.upsert_relationship_edge IS 'VTID-01090: Upsert a relationship edge with strength increment';

-- ===========================================================================
-- 7. RPC: live_room_create
-- ===========================================================================

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

    IF v_title IS NULL OR v_title = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_TITLE', 'message', 'title is required');
    END IF;

    -- Create room
    INSERT INTO public.live_rooms (
        tenant_id,
        title,
        topic_keys,
        host_user_id,
        starts_at
    )
    VALUES (
        v_tenant_id,
        v_title,
        v_topic_keys,
        v_user_id,
        v_starts_at
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

GRANT EXECUTE ON FUNCTION public.live_room_create(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_create(JSONB) TO service_role;

COMMENT ON FUNCTION public.live_room_create IS 'VTID-01090: Create a new live room';

-- ===========================================================================
-- 8. RPC: live_room_start
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.live_room_start(p_live_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_room RECORD;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED');
    END IF;

    -- Get room and verify host
    SELECT * INTO v_room
    FROM public.live_rooms
    WHERE id = p_live_room_id
      AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
    END IF;

    IF v_room.host_user_id != v_user_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST', 'message', 'Only the host can start the room');
    END IF;

    IF v_room.status != 'scheduled' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATUS', 'message', 'Room is not in scheduled status');
    END IF;

    -- Update status
    UPDATE public.live_rooms
    SET status = 'live',
        starts_at = NOW(),
        updated_at = NOW()
    WHERE id = p_live_room_id;

    RETURN jsonb_build_object(
        'ok', true,
        'live_room_id', p_live_room_id,
        'status', 'live',
        'started_at', NOW()
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.live_room_start(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_start(UUID) TO service_role;

COMMENT ON FUNCTION public.live_room_start IS 'VTID-01090: Start a scheduled live room';

-- ===========================================================================
-- 9. RPC: live_room_end
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.live_room_end(p_live_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_room RECORD;
    v_attendee RECORD;
    v_duration_bonus INT;
    v_edge_result JSONB;
    v_edges_strengthened INT := 0;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED');
    END IF;

    -- Get room and verify host
    SELECT * INTO v_room
    FROM public.live_rooms
    WHERE id = p_live_room_id
      AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
    END IF;

    IF v_room.host_user_id != v_user_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
    END IF;

    IF v_room.status != 'live' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_LIVE');
    END IF;

    -- End the room
    UPDATE public.live_rooms
    SET status = 'ended',
        ends_at = NOW(),
        updated_at = NOW()
    WHERE id = p_live_room_id;

    -- Update any remaining attendees' left_at
    UPDATE public.live_room_attendance
    SET left_at = NOW()
    WHERE live_room_id = p_live_room_id
      AND left_at IS NULL;

    -- Process attendance edges with duration bonus
    FOR v_attendee IN
        SELECT user_id, joined_at, left_at,
               EXTRACT(EPOCH FROM (COALESCE(left_at, NOW()) - joined_at)) / 60 AS duration_minutes
        FROM public.live_room_attendance
        WHERE live_room_id = p_live_room_id
          AND tenant_id = v_tenant_id
    LOOP
        -- Base attendance strength
        v_duration_bonus := 0;

        -- +10 bonus for staying > 20 minutes
        IF v_attendee.duration_minutes >= 20 THEN
            v_duration_bonus := 10;
        END IF;

        -- Strengthen person -> live_room edge
        v_edge_result := public.upsert_relationship_edge(
            v_tenant_id,
            'person',
            v_attendee.user_id,
            'live_room',
            p_live_room_id,
            'attendee',
            v_duration_bonus,
            jsonb_build_object('duration_minutes', v_attendee.duration_minutes, 'completed', true)
        );

        IF (v_edge_result->>'ok')::BOOLEAN THEN
            v_edges_strengthened := v_edges_strengthened + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'live_room_id', p_live_room_id,
        'status', 'ended',
        'ended_at', NOW(),
        'edges_strengthened', v_edges_strengthened
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.live_room_end(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_end(UUID) TO service_role;

COMMENT ON FUNCTION public.live_room_end IS 'VTID-01090: End a live room and process attendance edges';

-- ===========================================================================
-- 10. RPC: live_room_join
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.live_room_join(p_live_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_room RECORD;
    v_attendance_id UUID;
    v_other_attendee RECORD;
    v_coattendance_count INT;
    v_daily_cap INT := 15;  -- Cap co-attendance edges per day
    v_coattendance_today INT;
    v_edge_result JSONB;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED');
    END IF;

    -- Verify room exists and is live
    SELECT * INTO v_room
    FROM public.live_rooms
    WHERE id = p_live_room_id
      AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
    END IF;

    IF v_room.status != 'live' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_LIVE', 'message', 'Room is not currently live');
    END IF;

    -- Insert attendance (or update if rejoining)
    INSERT INTO public.live_room_attendance (
        tenant_id,
        live_room_id,
        user_id,
        joined_at
    )
    VALUES (
        v_tenant_id,
        p_live_room_id,
        v_user_id,
        NOW()
    )
    ON CONFLICT (tenant_id, live_room_id, user_id)
    DO UPDATE SET
        left_at = NULL  -- Clear left_at if rejoining
    RETURNING id INTO v_attendance_id;

    -- Create/strengthen person -> live_room attendee edge (+15 for attending)
    v_edge_result := public.upsert_relationship_edge(
        v_tenant_id,
        'person',
        v_user_id,
        'live_room',
        p_live_room_id,
        'attendee',
        15,  -- Attended strength
        jsonb_build_object('joined_at', NOW())
    );

    -- Check co-attendance cap for today
    SELECT COUNT(*)
    INTO v_coattendance_today
    FROM public.relationship_edges
    WHERE tenant_id = v_tenant_id
      AND source_type = 'person'
      AND source_id = v_user_id
      AND target_type = 'person'
      AND edge_type = 'coattendance'
      AND DATE(last_interaction_at) = CURRENT_DATE;

    -- Create co-attendance edges with other current attendees (up to daily cap)
    v_coattendance_count := 0;
    FOR v_other_attendee IN
        SELECT user_id
        FROM public.live_room_attendance
        WHERE live_room_id = p_live_room_id
          AND tenant_id = v_tenant_id
          AND user_id != v_user_id
          AND left_at IS NULL
    LOOP
        -- Check daily cap
        IF v_coattendance_today + v_coattendance_count >= v_daily_cap THEN
            EXIT;
        END IF;

        -- Create bidirectional co-attendance edge (+3 each)
        PERFORM public.upsert_relationship_edge(
            v_tenant_id,
            'person',
            v_user_id,
            'person',
            v_other_attendee.user_id,
            'coattendance',
            3,
            jsonb_build_object('room_id', p_live_room_id, 'coattendance_at', NOW())
        );

        PERFORM public.upsert_relationship_edge(
            v_tenant_id,
            'person',
            v_other_attendee.user_id,
            'person',
            v_user_id,
            'coattendance',
            3,
            jsonb_build_object('room_id', p_live_room_id, 'coattendance_at', NOW())
        );

        v_coattendance_count := v_coattendance_count + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'attendance_id', v_attendance_id,
        'live_room_id', p_live_room_id,
        'joined_at', NOW(),
        'coattendance_edges_created', v_coattendance_count
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.live_room_join(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_join(UUID) TO service_role;

COMMENT ON FUNCTION public.live_room_join IS 'VTID-01090: Join a live room and strengthen relationship edges';

-- ===========================================================================
-- 11. RPC: live_room_leave
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.live_room_leave(p_live_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_attendance RECORD;
    v_duration_minutes INT;
    v_duration_bonus INT := 0;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED');
    END IF;

    -- Get attendance record
    SELECT * INTO v_attendance
    FROM public.live_room_attendance
    WHERE live_room_id = p_live_room_id
      AND tenant_id = v_tenant_id
      AND user_id = v_user_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'NOT_IN_ROOM');
    END IF;

    IF v_attendance.left_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_LEFT');
    END IF;

    -- Calculate duration
    v_duration_minutes := EXTRACT(EPOCH FROM (NOW() - v_attendance.joined_at)) / 60;

    -- Update left_at
    UPDATE public.live_room_attendance
    SET left_at = NOW()
    WHERE id = v_attendance.id;

    -- Apply duration bonus if stayed >= 20 minutes
    IF v_duration_minutes >= 20 THEN
        v_duration_bonus := 10;

        PERFORM public.upsert_relationship_edge(
            v_tenant_id,
            'person',
            v_user_id,
            'live_room',
            p_live_room_id,
            'attendee',
            v_duration_bonus,
            jsonb_build_object('duration_bonus', true, 'duration_minutes', v_duration_minutes)
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'live_room_id', p_live_room_id,
        'left_at', NOW(),
        'duration_minutes', v_duration_minutes,
        'duration_bonus_applied', v_duration_bonus > 0
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.live_room_leave(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_leave(UUID) TO service_role;

COMMENT ON FUNCTION public.live_room_leave IS 'VTID-01090: Leave a live room and apply duration bonuses';

-- ===========================================================================
-- 12. RPC: live_add_highlight
-- ===========================================================================

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
    v_tenant_id UUID;
    v_user_id UUID;
    v_room RECORD;
    v_highlight_id UUID;
    v_edge_result JSONB;
    v_memory_id UUID;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED');
    END IF;

    -- Validate type
    IF p_type NOT IN ('quote', 'moment', 'action_item', 'insight') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_TYPE', 'message', 'type must be: quote, moment, action_item, or insight');
    END IF;

    IF p_text IS NULL OR p_text = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_TEXT', 'message', 'text is required');
    END IF;

    -- Verify room exists and is live (or just ended)
    SELECT * INTO v_room
    FROM public.live_rooms
    WHERE id = p_live_room_id
      AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
    END IF;

    IF v_room.status NOT IN ('live', 'ended') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_ACTIVE', 'message', 'Can only add highlights to live or recently ended rooms');
    END IF;

    -- Insert highlight
    INSERT INTO public.live_highlights (
        tenant_id,
        live_room_id,
        created_by_user_id,
        highlight_type,
        text
    )
    VALUES (
        v_tenant_id,
        p_live_room_id,
        v_user_id,
        p_type,
        p_text
    )
    RETURNING id INTO v_highlight_id;

    -- Strengthen person -> live_room edge (+8 for creating highlight)
    v_edge_result := public.upsert_relationship_edge(
        v_tenant_id,
        'person',
        v_user_id,
        'live_room',
        p_live_room_id,
        'attendee',
        8,  -- Highlight creation strength
        jsonb_build_object('highlight_id', v_highlight_id, 'highlight_type', p_type)
    );

    -- Optional: Create memory garden node (if memory_items table exists)
    BEGIN
        INSERT INTO public.memory_items (
            tenant_id,
            user_id,
            category_key,
            source,
            content,
            content_json,
            importance
        )
        VALUES (
            v_tenant_id,
            v_user_id,
            'community',
            'system',
            p_text,
            jsonb_build_object(
                'highlight_id', v_highlight_id,
                'live_room_id', p_live_room_id,
                'highlight_type', p_type,
                'room_title', v_room.title
            ),
            30  -- Medium importance for highlights
        )
        RETURNING id INTO v_memory_id;
    EXCEPTION WHEN OTHERS THEN
        -- Memory items table may not exist, that's OK
        v_memory_id := NULL;
    END;

    RETURN jsonb_build_object(
        'ok', true,
        'highlight_id', v_highlight_id,
        'live_room_id', p_live_room_id,
        'type', p_type,
        'memory_id', v_memory_id,
        'edge_strengthened', (v_edge_result->>'ok')::BOOLEAN
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.live_add_highlight(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_add_highlight(UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.live_add_highlight IS 'VTID-01090: Add a highlight to a live room and strengthen edges';

-- ===========================================================================
-- 13. RPC: meetup_rsvp
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.meetup_rsvp(
    p_meetup_id UUID,
    p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_user_id UUID;
    v_old_status TEXT;
    v_attendance_id UUID;
    v_strength_delta INT;
    v_edge_result JSONB;
    v_other_attendee RECORD;
    v_coattendance_count INT := 0;
    v_daily_cap INT := 15;
    v_coattendance_today INT;
BEGIN
    v_tenant_id := public.current_tenant_id();
    v_user_id := public.current_user_id();

    IF v_tenant_id IS NULL OR v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED');
    END IF;

    -- Validate status
    IF p_status NOT IN ('rsvp', 'attended', 'no_show') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATUS', 'message', 'status must be: rsvp, attended, or no_show');
    END IF;

    -- Get existing attendance record if any
    SELECT status INTO v_old_status
    FROM public.event_attendance
    WHERE tenant_id = v_tenant_id
      AND meetup_id = p_meetup_id
      AND user_id = v_user_id;

    -- Calculate strength delta based on status transition
    v_strength_delta := 0;
    IF p_status = 'rsvp' AND (v_old_status IS NULL OR v_old_status != 'rsvp') THEN
        v_strength_delta := 5;  -- RSVP: +5
    ELSIF p_status = 'attended' AND v_old_status != 'attended' THEN
        IF v_old_status = 'rsvp' THEN
            v_strength_delta := 10;  -- Attended after RSVP: +10 (total +15)
        ELSE
            v_strength_delta := 15;  -- Attended without RSVP: +15
        END IF;
    END IF;

    -- Upsert attendance record
    INSERT INTO public.event_attendance (
        tenant_id,
        meetup_id,
        user_id,
        status,
        rsvp_at,
        attended_at
    )
    VALUES (
        v_tenant_id,
        p_meetup_id,
        v_user_id,
        p_status,
        CASE WHEN p_status = 'rsvp' THEN NOW() ELSE NULL END,
        CASE WHEN p_status = 'attended' THEN NOW() ELSE NULL END
    )
    ON CONFLICT (tenant_id, meetup_id, user_id)
    DO UPDATE SET
        status = p_status,
        rsvp_at = CASE
            WHEN p_status = 'rsvp' AND event_attendance.rsvp_at IS NULL THEN NOW()
            ELSE event_attendance.rsvp_at
        END,
        attended_at = CASE
            WHEN p_status = 'attended' THEN NOW()
            ELSE event_attendance.attended_at
        END,
        updated_at = NOW()
    RETURNING id INTO v_attendance_id;

    -- Strengthen person -> meetup edge
    IF v_strength_delta > 0 THEN
        v_edge_result := public.upsert_relationship_edge(
            v_tenant_id,
            'person',
            v_user_id,
            'meetup',
            p_meetup_id,
            'attendee',
            v_strength_delta,
            jsonb_build_object('status', p_status, 'updated_at', NOW())
        );
    END IF;

    -- If attended, create co-attendance edges
    IF p_status = 'attended' THEN
        -- Check daily cap
        SELECT COUNT(*)
        INTO v_coattendance_today
        FROM public.relationship_edges
        WHERE tenant_id = v_tenant_id
          AND source_type = 'person'
          AND source_id = v_user_id
          AND target_type = 'person'
          AND edge_type = 'coattendance'
          AND DATE(last_interaction_at) = CURRENT_DATE;

        -- Create co-attendance with other attendees
        FOR v_other_attendee IN
            SELECT user_id
            FROM public.event_attendance
            WHERE meetup_id = p_meetup_id
              AND tenant_id = v_tenant_id
              AND user_id != v_user_id
              AND status = 'attended'
        LOOP
            IF v_coattendance_today + v_coattendance_count >= v_daily_cap THEN
                EXIT;
            END IF;

            -- Bidirectional co-attendance
            PERFORM public.upsert_relationship_edge(
                v_tenant_id,
                'person',
                v_user_id,
                'person',
                v_other_attendee.user_id,
                'coattendance',
                3,
                jsonb_build_object('meetup_id', p_meetup_id, 'coattendance_at', NOW())
            );

            PERFORM public.upsert_relationship_edge(
                v_tenant_id,
                'person',
                v_other_attendee.user_id,
                'person',
                v_user_id,
                'coattendance',
                3,
                jsonb_build_object('meetup_id', p_meetup_id, 'coattendance_at', NOW())
            );

            v_coattendance_count := v_coattendance_count + 1;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'attendance_id', v_attendance_id,
        'meetup_id', p_meetup_id,
        'status', p_status,
        'previous_status', v_old_status,
        'strength_delta', v_strength_delta,
        'coattendance_edges_created', v_coattendance_count
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.meetup_rsvp(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.meetup_rsvp(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.meetup_rsvp IS 'VTID-01090: RSVP or update attendance status for a meetup';

-- ===========================================================================
-- 14. RPC: get_live_room_summary
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.get_live_room_summary(p_live_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_room RECORD;
    v_attendance_count INT;
    v_highlight_count INT;
    v_avg_duration NUMERIC;
    v_highlights JSONB;
BEGIN
    v_tenant_id := public.current_tenant_id();

    IF v_tenant_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TENANT_NOT_FOUND');
    END IF;

    -- Get room details
    SELECT * INTO v_room
    FROM public.live_rooms
    WHERE id = p_live_room_id
      AND tenant_id = v_tenant_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
    END IF;

    -- Get attendance stats
    SELECT
        COUNT(*),
        COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(left_at, NOW()) - joined_at)) / 60), 0)
    INTO v_attendance_count, v_avg_duration
    FROM public.live_room_attendance
    WHERE live_room_id = p_live_room_id
      AND tenant_id = v_tenant_id;

    -- Get highlight count
    SELECT COUNT(*) INTO v_highlight_count
    FROM public.live_highlights
    WHERE live_room_id = p_live_room_id
      AND tenant_id = v_tenant_id;

    -- Get recent highlights
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', id,
            'type', highlight_type,
            'text', text,
            'created_at', created_at
        )
        ORDER BY created_at DESC
    ), '[]'::JSONB)
    INTO v_highlights
    FROM public.live_highlights
    WHERE live_room_id = p_live_room_id
      AND tenant_id = v_tenant_id
    LIMIT 10;

    RETURN jsonb_build_object(
        'ok', true,
        'live_room_id', p_live_room_id,
        'title', v_room.title,
        'status', v_room.status,
        'host_user_id', v_room.host_user_id,
        'topic_keys', v_room.topic_keys,
        'starts_at', v_room.starts_at,
        'ends_at', v_room.ends_at,
        'stats', jsonb_build_object(
            'attendance_count', v_attendance_count,
            'highlight_count', v_highlight_count,
            'avg_duration_minutes', ROUND(v_avg_duration::NUMERIC, 1)
        ),
        'recent_highlights', v_highlights
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_live_room_summary(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_live_room_summary(UUID) TO service_role;

COMMENT ON FUNCTION public.get_live_room_summary IS 'VTID-01090: Get summary statistics for a live room';

-- ===========================================================================
-- PERMISSIONS
-- ===========================================================================

-- Tables
GRANT SELECT ON public.relationship_edges TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.relationship_edges TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.live_rooms TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_rooms TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.live_room_attendance TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_room_attendance TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.event_attendance TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_attendance TO service_role;

GRANT SELECT, INSERT ON public.live_highlights TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_highlights TO service_role;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $$
DECLARE
    v_table_count INT;
    v_function_count INT;
BEGIN
    -- Verify tables
    SELECT COUNT(*) INTO v_table_count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('relationship_edges', 'live_rooms', 'live_room_attendance', 'event_attendance', 'live_highlights');

    IF v_table_count = 5 THEN
        RAISE NOTICE 'VERIFY OK: All 5 VTID-01090 tables exist';
    ELSE
        RAISE WARNING 'VERIFY FAIL: Expected 5 tables, found %', v_table_count;
    END IF;

    -- Verify functions
    SELECT COUNT(*) INTO v_function_count
    FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name IN (
        'upsert_relationship_edge',
        'live_room_create',
        'live_room_start',
        'live_room_end',
        'live_room_join',
        'live_room_leave',
        'live_add_highlight',
        'meetup_rsvp',
        'get_live_room_summary'
    );

    IF v_function_count >= 8 THEN
        RAISE NOTICE 'VERIFY OK: VTID-01090 RPC functions exist (% found)', v_function_count;
    ELSE
        RAISE WARNING 'VERIFY FAIL: Expected at least 8 functions, found %', v_function_count;
    END IF;
END $$;

-- ===========================================================================
-- Migration Complete
-- ===========================================================================
