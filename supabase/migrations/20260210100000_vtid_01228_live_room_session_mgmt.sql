-- =============================================================================
-- VTID-01228: Live Room Session Management
--
-- Adds the permanent room model, session lifecycle, lobby system,
-- host presence gate, and all supporting RPCs/RLS/triggers.
--
-- Depends on:
--   20251231000000_vtid_01101_phase_a_bootstrap.sql (app_users, user_tenants, tenants)
--   20251231000001_vtid_01090_live_rooms_events_graph.sql (live_rooms, live_room_attendance)
--   20260209_vtid_01228_daily_co_live_rooms_fixed.sql (live_room_access_grants)
--   20260210000000_vtid_01090_fix_live_room_creation.sql (access_level, metadata on live_rooms)
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. EXTEND live_rooms (permanent room identity)
-- =============================================================================

-- Add 'idle', 'lobby', 'cancelled' to status CHECK
ALTER TABLE public.live_rooms DROP CONSTRAINT IF EXISTS live_rooms_status_check;
ALTER TABLE public.live_rooms ADD CONSTRAINT live_rooms_status_check
  CHECK (status IN ('idle', 'scheduled', 'lobby', 'live', 'ended', 'cancelled'));

-- New columns for permanent room identity
ALTER TABLE public.live_rooms ADD COLUMN IF NOT EXISTS room_name TEXT;
ALTER TABLE public.live_rooms ADD COLUMN IF NOT EXISTS room_slug TEXT;
ALTER TABLE public.live_rooms ADD COLUMN IF NOT EXISTS current_session_id UUID;
ALTER TABLE public.live_rooms ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
ALTER TABLE public.live_rooms ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.live_rooms ADD COLUMN IF NOT EXISTS host_present BOOLEAN DEFAULT false;

-- Unique index on slug (partial - only non-null slugs)
CREATE UNIQUE INDEX IF NOT EXISTS idx_live_rooms_slug
  ON public.live_rooms (room_slug) WHERE room_slug IS NOT NULL;

-- =============================================================================
-- 2. EXTEND app_users (link to permanent room)
-- =============================================================================

ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS live_room_id UUID;
-- FK added after backfill to avoid chicken-and-egg issues

-- =============================================================================
-- 3. CREATE live_room_sessions table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.live_room_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  room_id UUID NOT NULL REFERENCES public.live_rooms(id) ON DELETE CASCADE,
  session_title TEXT,
  topic_keys TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'lobby', 'live', 'ended', 'cancelled')),
  access_level TEXT DEFAULT 'public'
    CHECK (access_level IN ('public', 'group')),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NULL,
  lobby_open_at TIMESTAMPTZ NULL,
  host_present BOOLEAN DEFAULT false,
  auto_admit BOOLEAN DEFAULT true,
  lobby_buffer_minutes INT DEFAULT 15,
  max_participants INT DEFAULT 100,
  metadata JSONB DEFAULT '{}'::JSONB,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique on idempotency_key (partial - only non-null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_live_room_sessions_idempotency
  ON public.live_room_sessions (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_live_room_sessions_room
  ON public.live_room_sessions (room_id);
CREATE INDEX IF NOT EXISTS idx_live_room_sessions_status
  ON public.live_room_sessions (status) WHERE status NOT IN ('ended', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_live_room_sessions_tenant
  ON public.live_room_sessions (tenant_id);

-- RLS
ALTER TABLE public.live_room_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sessions_select_tenant" ON public.live_room_sessions
  FOR SELECT USING (
    tenant_id IN (SELECT tenant_id FROM public.user_tenants WHERE user_id = auth.uid())
  );

CREATE POLICY "sessions_service_role" ON public.live_room_sessions
  FOR ALL USING (
    (SELECT current_setting('request.jwt.claim.role', true)) = 'service_role'
  );

-- FK from live_rooms.current_session_id → live_room_sessions.id
ALTER TABLE public.live_rooms ADD CONSTRAINT fk_live_rooms_current_session
  FOREIGN KEY (current_session_id) REFERENCES public.live_room_sessions(id)
  ON DELETE SET NULL;

-- =============================================================================
-- 4. EXTEND live_room_attendance (session-scoped)
-- =============================================================================

ALTER TABLE public.live_room_attendance ADD COLUMN IF NOT EXISTS session_id UUID;
ALTER TABLE public.live_room_attendance ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'guest';
ALTER TABLE public.live_room_attendance ADD COLUMN IF NOT EXISTS lobby_status TEXT;
ALTER TABLE public.live_room_attendance ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false;
ALTER TABLE public.live_room_attendance ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;

-- Add FK for session_id (after table exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_attendance_session'
  ) THEN
    ALTER TABLE public.live_room_attendance
      ADD CONSTRAINT fk_attendance_session
      FOREIGN KEY (session_id) REFERENCES public.live_room_sessions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Drop old unique constraint, add session-scoped one
ALTER TABLE public.live_room_attendance
  DROP CONSTRAINT IF EXISTS live_room_attendance_tenant_id_live_room_id_user_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_unique_session
  ON public.live_room_attendance (tenant_id, session_id, user_id)
  WHERE session_id IS NOT NULL;

-- Keep old constraint for legacy rows without session_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_unique_legacy
  ON public.live_room_attendance (tenant_id, live_room_id, user_id)
  WHERE session_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_session
  ON public.live_room_attendance (session_id) WHERE session_id IS NOT NULL;

-- Add CHECK on lobby_status
ALTER TABLE public.live_room_attendance DROP CONSTRAINT IF EXISTS attendance_lobby_status_check;
ALTER TABLE public.live_room_attendance ADD CONSTRAINT attendance_lobby_status_check
  CHECK (lobby_status IS NULL OR lobby_status IN ('waiting', 'admitted', 'rejected'));

-- Add CHECK on role
ALTER TABLE public.live_room_attendance DROP CONSTRAINT IF EXISTS attendance_role_check;
ALTER TABLE public.live_room_attendance ADD CONSTRAINT attendance_role_check
  CHECK (role IN ('host', 'guest'));

-- =============================================================================
-- 5. EXTEND live_room_access_grants (session-scoped + refund tracking)
-- =============================================================================

ALTER TABLE public.live_room_access_grants ADD COLUMN IF NOT EXISTS session_id UUID;
ALTER TABLE public.live_room_access_grants ADD COLUMN IF NOT EXISTS refund_status TEXT;

-- Add FK for session_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_grants_session'
  ) THEN
    ALTER TABLE public.live_room_access_grants
      ADD CONSTRAINT fk_grants_session
      FOREIGN KEY (session_id) REFERENCES public.live_room_sessions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Check on refund_status
ALTER TABLE public.live_room_access_grants DROP CONSTRAINT IF EXISTS grants_refund_status_check;
ALTER TABLE public.live_room_access_grants ADD CONSTRAINT grants_refund_status_check
  CHECK (refund_status IS NULL OR refund_status IN ('pending', 'succeeded', 'failed'));

-- =============================================================================
-- 6. TRIGGER: Create permanent room on user_tenants INSERT (is_primary=true)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_user_live_room()
RETURNS TRIGGER AS $$
DECLARE
  v_room_id UUID;
  v_display_name TEXT;
  v_slug TEXT;
  v_existing_room UUID;
BEGIN
  -- Only fire for primary tenant assignment
  IF NEW.is_primary IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Check if user already has a room (idempotent)
  SELECT live_room_id INTO v_existing_room FROM public.app_users WHERE user_id = NEW.user_id;
  IF v_existing_room IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Get display name from app_users
  SELECT display_name INTO v_display_name FROM public.app_users WHERE user_id = NEW.user_id;

  -- Generate slug with collision safety: base slug + first 6 chars of user_id
  v_slug := lower(regexp_replace(
    COALESCE(v_display_name, 'user'),
    '[^a-z0-9]+', '-', 'g'
  )) || '-' || left(NEW.user_id::TEXT, 6);

  -- Trim leading/trailing hyphens
  v_slug := trim(BOTH '-' FROM v_slug);

  -- Create permanent room
  INSERT INTO public.live_rooms (tenant_id, title, host_user_id, starts_at, status, room_name, room_slug)
  VALUES (
    NEW.tenant_id,
    COALESCE(v_display_name, 'My') || '''s Room',
    NEW.user_id,
    NOW(),
    'idle',
    COALESCE(v_display_name, 'My') || '''s Room',
    v_slug
  )
  ON CONFLICT (room_slug) WHERE room_slug IS NOT NULL DO UPDATE SET
    room_slug = EXCLUDED.room_slug || '-' || left(gen_random_uuid()::TEXT, 4)
  RETURNING id INTO v_room_id;

  -- Link room to user
  UPDATE public.app_users SET live_room_id = v_room_id WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop existing trigger if any, then create
DROP TRIGGER IF EXISTS trg_create_user_live_room ON public.user_tenants;
CREATE TRIGGER trg_create_user_live_room
  AFTER INSERT ON public.user_tenants
  FOR EACH ROW
  WHEN (NEW.is_primary = true)
  EXECUTE FUNCTION public.create_user_live_room();

-- =============================================================================
-- 7. BACKFILL: Create rooms for existing users who don't have one
-- =============================================================================

DO $$
DECLARE
  r RECORD;
  v_room_id UUID;
  v_slug TEXT;
BEGIN
  FOR r IN
    SELECT au.user_id, au.display_name, ut.tenant_id
    FROM public.app_users au
    JOIN public.user_tenants ut ON ut.user_id = au.user_id AND ut.is_primary = true
    WHERE au.live_room_id IS NULL
  LOOP
    v_slug := lower(regexp_replace(
      COALESCE(r.display_name, 'user'),
      '[^a-z0-9]+', '-', 'g'
    )) || '-' || left(r.user_id::TEXT, 6);
    v_slug := trim(BOTH '-' FROM v_slug);

    INSERT INTO public.live_rooms (tenant_id, title, host_user_id, starts_at, status, room_name, room_slug)
    VALUES (
      r.tenant_id,
      COALESCE(r.display_name, 'My') || '''s Room',
      r.user_id,
      NOW(),
      'idle',
      COALESCE(r.display_name, 'My') || '''s Room',
      v_slug
    )
    ON CONFLICT (room_slug) WHERE room_slug IS NOT NULL DO UPDATE SET
      room_slug = EXCLUDED.room_slug || '-' || left(gen_random_uuid()::TEXT, 4)
    RETURNING id INTO v_room_id;

    UPDATE public.app_users SET live_room_id = v_room_id WHERE user_id = r.user_id;
  END LOOP;
END $$;

-- Now add FK constraint (after backfill)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_app_users_live_room'
  ) THEN
    ALTER TABLE public.app_users
      ADD CONSTRAINT fk_app_users_live_room
      FOREIGN KEY (live_room_id) REFERENCES public.live_rooms(id) ON DELETE SET NULL;
  END IF;
END $$;

-- =============================================================================
-- 8. RPCs: Session Lifecycle
-- =============================================================================

-- 8a. Create a new session ("Go Live")
CREATE OR REPLACE FUNCTION public.live_room_create_session(
  p_room_id UUID,
  p_payload JSONB
)
RETURNS JSONB AS $$
DECLARE
  v_room RECORD;
  v_session_id UUID;
  v_initial_status TEXT;
  v_starts_at TIMESTAMPTZ;
  v_auto_admit BOOLEAN;
  v_idempotency_key TEXT;
  v_existing_session UUID;
BEGIN
  -- Validate caller is host
  SELECT * INTO v_room FROM public.live_rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
  END IF;
  IF v_room.host_user_id != auth.uid() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  -- Room must be idle
  IF v_room.status != 'idle' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_IDLE', 'message', 'Room already has an active session');
  END IF;

  -- Check idempotency
  v_idempotency_key := p_payload->>'idempotency_key';
  IF v_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_session
    FROM public.live_room_sessions
    WHERE idempotency_key = v_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'session_id', v_existing_session, 'idempotent', true);
    END IF;
  END IF;

  -- Determine initial status
  v_starts_at := COALESCE((p_payload->>'starts_at')::TIMESTAMPTZ, NOW());
  v_auto_admit := COALESCE((p_payload->>'auto_admit')::BOOLEAN, true);

  IF v_starts_at <= NOW() THEN
    -- Instant go live
    IF v_auto_admit THEN
      v_initial_status := 'live';
    ELSE
      v_initial_status := 'lobby';
    END IF;
  ELSE
    v_initial_status := 'scheduled';
  END IF;

  -- Create session
  INSERT INTO public.live_room_sessions (
    tenant_id, room_id, session_title, topic_keys, status,
    access_level, starts_at, ends_at, auto_admit,
    lobby_buffer_minutes, max_participants, metadata, idempotency_key
  ) VALUES (
    v_room.tenant_id,
    p_room_id,
    p_payload->>'session_title',
    COALESCE((SELECT array_agg(elem::TEXT) FROM jsonb_array_elements_text(p_payload->'topic_keys') AS elem), '{}'),
    v_initial_status,
    COALESCE(p_payload->>'access_level', 'public'),
    v_starts_at,
    (p_payload->>'ends_at')::TIMESTAMPTZ,
    v_auto_admit,
    COALESCE((p_payload->>'lobby_buffer_minutes')::INT, 15),
    COALESCE((p_payload->>'max_participants')::INT, 100),
    COALESCE(p_payload->'metadata', '{}'::JSONB),
    v_idempotency_key
  )
  RETURNING id INTO v_session_id;

  -- Update room: link session + set status
  UPDATE public.live_rooms
  SET current_session_id = v_session_id,
      status = v_initial_status,
      access_level = COALESCE(p_payload->>'access_level', 'public'),
      host_present = false,
      updated_at = NOW()
  WHERE id = p_room_id AND status = 'idle';

  RETURN jsonb_build_object(
    'ok', true,
    'session_id', v_session_id,
    'status', v_initial_status,
    'room_id', p_room_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8b. Transition room+session status (optimistic locking)
CREATE OR REPLACE FUNCTION public.live_room_transition_status(
  p_room_id UUID,
  p_new_status TEXT,
  p_expected_old_status TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_updated_count INT;
  v_session_id UUID;
BEGIN
  -- Validate caller is host
  IF NOT EXISTS (
    SELECT 1 FROM public.live_rooms
    WHERE id = p_room_id AND host_user_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  -- Optimistic lock: update only if expected status matches
  UPDATE public.live_rooms
  SET status = p_new_status, updated_at = NOW()
  WHERE id = p_room_id AND status = p_expected_old_status
  RETURNING current_session_id INTO v_session_id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CONFLICT', 'message', 'Room state already changed');
  END IF;

  -- Also update the session status
  IF v_session_id IS NOT NULL THEN
    UPDATE public.live_room_sessions
    SET status = p_new_status, updated_at = NOW()
    WHERE id = v_session_id;

    -- Set lobby_open_at if transitioning to lobby
    IF p_new_status = 'lobby' THEN
      UPDATE public.live_room_sessions
      SET lobby_open_at = NOW()
      WHERE id = v_session_id AND lobby_open_at IS NULL;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'new_status', p_new_status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8c. End session (reset room to idle)
CREATE OR REPLACE FUNCTION public.live_room_end_session(p_room_id UUID)
RETURNS JSONB AS $$
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
  IF v_room.status NOT IN ('live', 'lobby', 'scheduled') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATE');
  END IF;

  -- End the session
  IF v_room.current_session_id IS NOT NULL THEN
    UPDATE public.live_room_sessions
    SET status = 'ended', ends_at = COALESCE(ends_at, NOW()), updated_at = NOW()
    WHERE id = v_room.current_session_id;

    -- Set left_at on all active attendance
    UPDATE public.live_room_attendance
    SET left_at = NOW()
    WHERE session_id = v_room.current_session_id AND left_at IS NULL;
  END IF;

  -- Reset room to idle
  UPDATE public.live_rooms
  SET status = 'idle',
      current_session_id = NULL,
      host_present = false,
      updated_at = NOW()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true, 'ended_session_id', v_room.current_session_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8d. Set host present/absent
CREATE OR REPLACE FUNCTION public.live_room_set_host_present(
  p_room_id UUID,
  p_present BOOLEAN
)
RETURNS JSONB AS $$
BEGIN
  -- Validate caller is host
  IF NOT EXISTS (
    SELECT 1 FROM public.live_rooms
    WHERE id = p_room_id AND host_user_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  UPDATE public.live_rooms
  SET host_present = p_present, updated_at = NOW()
  WHERE id = p_room_id;

  -- Also update session
  UPDATE public.live_room_sessions
  SET host_present = p_present, updated_at = NOW()
  WHERE id = (SELECT current_session_id FROM public.live_rooms WHERE id = p_room_id)
    AND current_session_id IS NOT NULL;

  RETURN jsonb_build_object('ok', true, 'host_present', p_present);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- 9. RPCs: Join & Attendance (session-scoped)
-- =============================================================================

-- 9a. Join a live room session
CREATE OR REPLACE FUNCTION public.live_room_join_session(
  p_room_id UUID,
  p_session_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_room RECORD;
  v_session RECORD;
  v_user_id UUID := auth.uid();
  v_role TEXT := 'guest';
  v_lobby_status TEXT;
  v_existing RECORD;
  v_in_room_count INT;
BEGIN
  -- Load room and session
  SELECT * INTO v_room FROM public.live_rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
  END IF;

  SELECT * INTO v_session FROM public.live_room_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SESSION_NOT_FOUND');
  END IF;

  -- Step 1: Room status check
  IF v_room.status NOT IN ('lobby', 'live') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_ACTIVE');
  END IF;

  -- Step 2: Ban check
  IF EXISTS (
    SELECT 1 FROM public.live_room_attendance
    WHERE session_id = p_session_id AND user_id = v_user_id AND is_banned = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BANNED');
  END IF;

  -- Step 3: Reconnection check (disconnected < 2 min ago)
  SELECT * INTO v_existing
  FROM public.live_room_attendance
  WHERE session_id = p_session_id AND user_id = v_user_id AND left_at IS NOT NULL
    AND disconnected_at IS NOT NULL AND disconnected_at > NOW() - INTERVAL '2 minutes'
    AND is_banned = false;
  IF FOUND THEN
    -- Reconnect: reset left_at and disconnected_at
    UPDATE public.live_room_attendance
    SET left_at = NULL, disconnected_at = NULL
    WHERE id = v_existing.id;
    RETURN jsonb_build_object('ok', true, 'role', v_existing.role, 'lobby_status', 'admitted', 'reconnected', true);
  END IF;

  -- Step 4: Host detection
  IF v_room.host_user_id = v_user_id THEN
    v_role := 'host';
    v_lobby_status := 'admitted';
  ELSE
    -- Step 5: Access check (paid room)
    IF v_session.access_level = 'group' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.live_room_access_grants
        WHERE (session_id = p_session_id OR (session_id IS NULL AND room_id = p_room_id))
          AND user_id = v_user_id AND is_valid = true AND is_revoked = false
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYMENT_REQUIRED');
      END IF;
      -- Paid users bypass lobby
      v_lobby_status := 'admitted';
    ELSE
      -- Free room: check auto_admit
      IF v_session.auto_admit OR v_room.status = 'live' THEN
        v_lobby_status := 'admitted';
      ELSE
        v_lobby_status := 'waiting';
      END IF;
    END IF;

    -- Step 6: Capacity check (only for admitted users)
    IF v_lobby_status = 'admitted' THEN
      SELECT COUNT(*) INTO v_in_room_count
      FROM public.live_room_attendance
      WHERE session_id = p_session_id AND left_at IS NULL AND is_banned = false
        AND lobby_status IN ('admitted');
      IF v_in_room_count >= v_session.max_participants THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ROOM_FULL');
      END IF;
    END IF;

    -- Step 7: Host presence check (only for live rooms, only for admitted guests)
    IF v_room.status = 'live' AND v_lobby_status = 'admitted' AND v_room.host_present = false THEN
      RETURN jsonb_build_object('ok', false, 'error', 'HOST_NOT_PRESENT');
    END IF;
  END IF;

  -- Check if already in session (not left)
  IF EXISTS (
    SELECT 1 FROM public.live_room_attendance
    WHERE session_id = p_session_id AND user_id = v_user_id AND left_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', true, 'role', v_role, 'lobby_status', v_lobby_status, 'already_joined', true);
  END IF;

  -- Insert attendance
  INSERT INTO public.live_room_attendance (
    tenant_id, live_room_id, session_id, user_id, role, lobby_status, joined_at
  ) VALUES (
    v_room.tenant_id, p_room_id, p_session_id, v_user_id, v_role, v_lobby_status, NOW()
  )
  ON CONFLICT (tenant_id, session_id, user_id) WHERE session_id IS NOT NULL
  DO UPDATE SET left_at = NULL, disconnected_at = NULL, lobby_status = v_lobby_status;

  RETURN jsonb_build_object('ok', true, 'role', v_role, 'lobby_status', v_lobby_status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- 10. RPCs: Lobby Management (host-only)
-- =============================================================================

-- 10a. Get lobby (waiting users)
CREATE OR REPLACE FUNCTION public.live_room_get_lobby(p_room_id UUID)
RETURNS JSONB AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.live_rooms WHERE id = p_room_id AND host_user_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  RETURN jsonb_build_object('ok', true, 'waiting', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'user_id', a.user_id,
      'display_name', u.display_name,
      'joined_at', a.joined_at
    )), '[]'::JSONB)
    FROM public.live_room_attendance a
    JOIN public.app_users u ON u.user_id = a.user_id
    WHERE a.live_room_id = p_room_id
      AND a.session_id = (SELECT current_session_id FROM public.live_rooms WHERE id = p_room_id)
      AND a.lobby_status = 'waiting'
      AND a.left_at IS NULL
  ));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10b. Admit user from lobby
CREATE OR REPLACE FUNCTION public.live_room_admit_user(p_room_id UUID, p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_session_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.live_rooms WHERE id = p_room_id AND host_user_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  SELECT current_session_id INTO v_session_id FROM public.live_rooms WHERE id = p_room_id;

  UPDATE public.live_room_attendance
  SET lobby_status = 'admitted'
  WHERE session_id = v_session_id AND user_id = p_user_id AND lobby_status = 'waiting' AND left_at IS NULL;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10c. Reject user from lobby
CREATE OR REPLACE FUNCTION public.live_room_reject_user(p_room_id UUID, p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_session_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.live_rooms WHERE id = p_room_id AND host_user_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  SELECT current_session_id INTO v_session_id FROM public.live_rooms WHERE id = p_room_id;

  UPDATE public.live_room_attendance
  SET lobby_status = 'rejected'
  WHERE session_id = v_session_id AND user_id = p_user_id AND lobby_status = 'waiting' AND left_at IS NULL;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10d. Admit all waiting users
CREATE OR REPLACE FUNCTION public.live_room_admit_all(p_room_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_session_id UUID;
  v_count INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.live_rooms WHERE id = p_room_id AND host_user_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  SELECT current_session_id INTO v_session_id FROM public.live_rooms WHERE id = p_room_id;

  UPDATE public.live_room_attendance
  SET lobby_status = 'admitted'
  WHERE session_id = v_session_id AND lobby_status = 'waiting' AND left_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'admitted_count', v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- 11. RPCs: Kick/Ban
-- =============================================================================

CREATE OR REPLACE FUNCTION public.live_room_kick_user(p_room_id UUID, p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_session_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.live_rooms WHERE id = p_room_id AND host_user_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  SELECT current_session_id INTO v_session_id FROM public.live_rooms WHERE id = p_room_id;

  UPDATE public.live_room_attendance
  SET left_at = NOW()
  WHERE session_id = v_session_id AND user_id = p_user_id AND left_at IS NULL;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.live_room_ban_user(p_room_id UUID, p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_session_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.live_rooms WHERE id = p_room_id AND host_user_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  SELECT current_session_id INTO v_session_id FROM public.live_rooms WHERE id = p_room_id;

  UPDATE public.live_room_attendance
  SET left_at = NOW(), is_banned = true
  WHERE session_id = v_session_id AND user_id = p_user_id AND left_at IS NULL;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- 12. RPCs: Counts & State Snapshot
-- =============================================================================

-- 12a. Get counts for a session
CREATE OR REPLACE FUNCTION public.live_room_get_counts(p_session_id UUID)
RETURNS JSONB AS $$
BEGIN
  RETURN (
    SELECT jsonb_build_object(
      'lobby_waiting', COUNT(*) FILTER (WHERE a.lobby_status = 'waiting' AND a.left_at IS NULL),
      'in_room', COUNT(*) FILTER (WHERE a.lobby_status = 'admitted' AND a.left_at IS NULL AND a.is_banned = false),
      'max_participants', (SELECT max_participants FROM public.live_room_sessions WHERE id = p_session_id),
      'host_present', (SELECT host_present FROM public.live_room_sessions WHERE id = p_session_id)
    )
    FROM public.live_room_attendance a
    WHERE a.session_id = p_session_id
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- 12b. Full state snapshot
CREATE OR REPLACE FUNCTION public.live_room_get_state(p_room_id UUID, p_user_id UUID DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
  v_room RECORD;
  v_session RECORD;
  v_counts JSONB;
  v_viewer JSONB := NULL;
  v_viewer_user_id UUID;
BEGIN
  v_viewer_user_id := COALESCE(p_user_id, auth.uid());

  SELECT * INTO v_room FROM public.live_rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
  END IF;

  -- Build room object
  -- Build session object (null if idle)
  IF v_room.current_session_id IS NOT NULL THEN
    SELECT * INTO v_session FROM public.live_room_sessions WHERE id = v_room.current_session_id;

    -- Get counts
    SELECT public.live_room_get_counts(v_room.current_session_id) INTO v_counts;

    -- Get viewer info
    IF v_viewer_user_id IS NOT NULL THEN
      SELECT jsonb_build_object(
        'role', COALESCE(a.role, CASE WHEN v_room.host_user_id = v_viewer_user_id THEN 'host' ELSE NULL END),
        'lobby_status', a.lobby_status,
        'is_banned', COALESCE(a.is_banned, false),
        'has_access_grant', EXISTS (
          SELECT 1 FROM public.live_room_access_grants
          WHERE (session_id = v_room.current_session_id OR (session_id IS NULL AND room_id = p_room_id))
            AND user_id = v_viewer_user_id AND is_valid = true AND is_revoked = false
        )
      ) INTO v_viewer
      FROM public.live_room_attendance a
      WHERE a.session_id = v_room.current_session_id AND a.user_id = v_viewer_user_id;

      -- If no attendance record yet, still return viewer with grant info
      IF v_viewer IS NULL AND v_viewer_user_id IS NOT NULL THEN
        v_viewer := jsonb_build_object(
          'role', CASE WHEN v_room.host_user_id = v_viewer_user_id THEN 'host' ELSE NULL END,
          'lobby_status', NULL,
          'is_banned', false,
          'has_access_grant', EXISTS (
            SELECT 1 FROM public.live_room_access_grants
            WHERE (session_id = v_room.current_session_id OR (session_id IS NULL AND room_id = p_room_id))
              AND user_id = v_viewer_user_id AND is_valid = true AND is_revoked = false
          )
        );
      END IF;
    END IF;
  ELSE
    v_counts := jsonb_build_object('lobby_waiting', 0, 'in_room', 0);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'room', jsonb_build_object(
      'id', v_room.id,
      'status', v_room.status,
      'room_name', v_room.room_name,
      'room_slug', v_room.room_slug,
      'host_user_id', v_room.host_user_id,
      'current_session_id', v_room.current_session_id
    ),
    'session', CASE WHEN v_room.current_session_id IS NOT NULL THEN jsonb_build_object(
      'id', v_session.id,
      'status', v_session.status,
      'session_title', v_session.session_title,
      'starts_at', v_session.starts_at,
      'ends_at', v_session.ends_at,
      'lobby_open_at', v_session.lobby_open_at,
      'host_present', v_session.host_present,
      'access_level', v_session.access_level,
      'auto_admit', v_session.auto_admit,
      'max_participants', v_session.max_participants
    ) ELSE NULL END,
    'counts', v_counts,
    'viewer', v_viewer
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- =============================================================================
-- 13. RPCs: Grant Management (session-scoped)
-- =============================================================================

-- Get paid grants for a session (for cancel-refund flow)
CREATE OR REPLACE FUNCTION public.live_room_get_paid_grants(p_session_id UUID)
RETURNS JSONB AS $$
BEGIN
  RETURN jsonb_build_object('ok', true, 'grants', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', g.id,
      'user_id', g.user_id,
      'stripe_payment_intent_id', g.stripe_payment_intent_id,
      'refund_status', g.refund_status
    )), '[]'::JSONB)
    FROM public.live_room_access_grants g
    WHERE g.session_id = p_session_id
      AND g.access_type = 'paid'
      AND g.is_valid = true
      AND g.is_revoked = false
  ));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update grant refund status
CREATE OR REPLACE FUNCTION public.live_room_update_grant_refund(
  p_grant_id UUID,
  p_refund_status TEXT,
  p_refund_id TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
BEGIN
  UPDATE public.live_room_access_grants
  SET refund_status = p_refund_status,
      refund_id = COALESCE(p_refund_id, refund_id),
      is_valid = CASE WHEN p_refund_status = 'succeeded' THEN false ELSE is_valid END,
      is_revoked = CASE WHEN p_refund_status = 'succeeded' THEN true ELSE is_revoked END,
      revoked_at = CASE WHEN p_refund_status = 'succeeded' THEN NOW() ELSE revoked_at END,
      revoked_reason = CASE WHEN p_refund_status = 'succeeded' THEN 'session_cancelled_refund' ELSE revoked_reason END
  WHERE id = p_grant_id;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Invalidate all grants for a session (on normal end — no refunds)
CREATE OR REPLACE FUNCTION public.live_room_invalidate_session_grants(p_session_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE public.live_room_access_grants
  SET is_valid = false
  WHERE session_id = p_session_id AND is_valid = true;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'invalidated_count', v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- 14. RPCs: Room Identity
-- =============================================================================

CREATE OR REPLACE FUNCTION public.live_room_update_room_name(
  p_room_id UUID,
  p_name TEXT DEFAULT NULL,
  p_slug TEXT DEFAULT NULL,
  p_cover_image_url TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.live_rooms WHERE id = p_room_id AND host_user_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  UPDATE public.live_rooms
  SET room_name = COALESCE(p_name, room_name),
      room_slug = COALESCE(p_slug, room_slug),
      cover_image_url = COALESCE(p_cover_image_url, cover_image_url),
      description = COALESCE(p_description, description),
      updated_at = NOW()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- 15. RPCs: Disconnect (for WebRTC drop)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.live_room_disconnect(p_room_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_session_id UUID;
BEGIN
  SELECT current_session_id INTO v_session_id FROM public.live_rooms WHERE id = p_room_id;

  UPDATE public.live_room_attendance
  SET left_at = NOW(), disconnected_at = NOW()
  WHERE session_id = v_session_id AND user_id = auth.uid() AND left_at IS NULL;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- 16. RPCs: Get sessions for a room (history)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.live_room_get_sessions(p_room_id UUID)
RETURNS JSONB AS $$
BEGIN
  RETURN jsonb_build_object('ok', true, 'sessions', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', s.id,
      'session_title', s.session_title,
      'status', s.status,
      'starts_at', s.starts_at,
      'ends_at', s.ends_at,
      'access_level', s.access_level,
      'max_participants', s.max_participants,
      'created_at', s.created_at
    ) ORDER BY s.created_at DESC), '[]'::JSONB)
    FROM public.live_room_sessions s
    WHERE s.room_id = p_room_id
  ));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMIT;
