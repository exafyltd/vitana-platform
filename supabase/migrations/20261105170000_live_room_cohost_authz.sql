-- VTID-05558 (live-room-edit-cohost / db-cohost-authz): a listed co-host runs the live.
--
-- Today every live-room moderation function compares the caller with live_rooms.host_user_id, so a co-host chosen when
-- the room was created is a plain guest. This migration:
--   1. adds public.live_room_is_host(room, user): the creator, or a user listed in community_live_streams.co_hosts
--      for that room id who is still in the room's tenant. NULL user -> false.
--   2. adds public.live_room_filter_co_hosts(creator, ids): the ids the gateway may store as co-hosts (same tenant as
--      the creator, not the creator, no test or service account, de-duplicated, order kept). service_role only.
--      The predicate is the one of _mention_recipient_ok (vitana-v1 VTID-04926) written inline, so this migration does
--      not depend on a vitana-v1 migration having run first.
--   3. switches the host gate of 13 functions to live_room_is_host. Each body below is the LATEST definition
--      (20260210100000_vtid_01228_live_room_session_mgmt.sql, 20260209_vtid_01228_daily_co_live_rooms_fixed.sql) with
--      only the host comparison changed; arguments, return types, SECURITY DEFINER and grants are unchanged.
--      kick/ban also refuse (TARGET_IS_HOST) a host target when the caller is not the room creator.
--      live_room_set_host_present: host_present is one flag per room, so a host leaving (host-absent) no longer clears
--      it while another host (creator or co-host) is still in the session. Its session UPDATE also lost the predicate
--      `AND current_session_id IS NOT NULL`: live_room_sessions has no such column in any migration, and
--      `id = (SELECT current_session_id ...)` already matches no row when that is NULL (same result, no failing column).
--      live_room_end_session used `host_user_id != auth.uid()`, which is NULL (so not rejected) for a caller without a
--      uid; the helper returns false for a NULL user, so that caller now gets NOT_HOST.
--   4. adds a trigger so a browser session (database role authenticated or anon) cannot set or change
--      community_live_streams.co_hosts. The gateway writes it with the service role.
-- Unchanged on purpose (creator only): live_room_create_session, live_room_update_room_name, live_room_start,
-- live_room_end, and the gateway cancel route.
--
-- ROLLBACK: re-apply the previous bodies of the 13 functions from the two files named above, then
--   DROP TRIGGER IF EXISTS trg_live_stream_co_hosts_gateway_only ON public.community_live_streams;
--   DROP FUNCTION IF EXISTS public.fn_live_stream_co_hosts_gateway_only();
--   DROP FUNCTION IF EXISTS public.live_room_filter_co_hosts(uuid, uuid[]);
--   DROP FUNCTION IF EXISTS public.live_room_is_host(uuid, uuid);
-- Applying this file is an owner decision (collaboration.md 7d).

BEGIN;

-- 1. Host helper ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.live_room_is_host(p_room_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.live_rooms lr
    WHERE lr.id = p_room_id
      AND (
        lr.host_user_id = p_user_id
        OR (
          EXISTS (
            SELECT 1 FROM public.community_live_streams cls
            WHERE cls.id = lr.id
              AND p_user_id::text = ANY (COALESCE(cls.co_hosts, '{}'::text[]))
          )
          AND EXISTS (
            SELECT 1 FROM public.user_tenants ut
            WHERE ut.user_id = p_user_id AND ut.tenant_id = lr.tenant_id
          )
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.live_room_is_host(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_is_host(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.live_room_is_host(uuid, uuid) IS
  'VTID-05558: true for the room creator (live_rooms.host_user_id) or a user listed in community_live_streams.co_hosts for the room who is in the room''s tenant. NULL user -> false.';

-- 2. Co-host validation (gateway, service role only) ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.live_room_filter_co_hosts(p_creator uuid, p_ids uuid[])
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(x.id ORDER BY x.ord), '{}'::uuid[])
  FROM (
    SELECT DISTINCT ON (u.id) u.id, u.ord
    FROM unnest(COALESCE(p_ids, '{}'::uuid[])) WITH ORDINALITY AS u(id, ord)
    WHERE u.id IS NOT NULL
      AND p_creator IS NOT NULL
      AND u.id <> p_creator
      AND NOT EXISTS (SELECT 1 FROM public.notification_test_actors t WHERE t.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts b WHERE b.user_id = u.id)
      AND EXISTS (
        SELECT 1 FROM public.user_tenants a
        JOIN public.user_tenants b ON b.tenant_id = a.tenant_id
        WHERE a.user_id = p_creator AND b.user_id = u.id
      )
    ORDER BY u.id, u.ord
  ) x;
$$;

REVOKE ALL ON FUNCTION public.live_room_filter_co_hosts(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_filter_co_hosts(uuid, uuid[]) TO service_role;

COMMENT ON FUNCTION public.live_room_filter_co_hosts(uuid, uuid[]) IS
  'VTID-05558: the ids the gateway may store as co-hosts of a room created by p_creator: same tenant, not the creator, no test/service account, de-duplicated, order kept.';

-- 3. Only the gateway writes co_hosts -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_live_stream_co_hosts_gateway_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      IF COALESCE(array_length(NEW.co_hosts, 1), 0) > 0 THEN
        RAISE EXCEPTION 'CO_HOSTS_GATEWAY_ONLY' USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.co_hosts IS DISTINCT FROM OLD.co_hosts THEN
      RAISE EXCEPTION 'CO_HOSTS_GATEWAY_ONLY' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_live_stream_co_hosts_gateway_only ON public.community_live_streams;
CREATE TRIGGER trg_live_stream_co_hosts_gateway_only
  BEFORE INSERT OR UPDATE OF co_hosts ON public.community_live_streams
  FOR EACH ROW EXECUTE FUNCTION public.fn_live_stream_co_hosts_gateway_only();

-- 4. The 13 host gates ----------------------------------------------------------------------------------------------
-- live_room_transition_status
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
  IF NOT public.live_room_is_host(p_room_id, auth.uid()) THEN
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

-- live_room_set_host_present
CREATE OR REPLACE FUNCTION public.live_room_set_host_present(
  p_room_id UUID,
  p_present BOOLEAN
)
RETURNS JSONB AS $$
BEGIN
  -- Validate caller is host
  IF NOT public.live_room_is_host(p_room_id, auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  -- Another host still in the session keeps the room 'host present'.
  IF NOT p_present AND EXISTS (
    SELECT 1 FROM public.live_room_attendance a
    WHERE a.session_id = (SELECT current_session_id FROM public.live_rooms WHERE id = p_room_id)
      AND a.role = 'host' AND a.left_at IS NULL AND a.user_id <> auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', true, 'host_present', true);
  END IF;

  UPDATE public.live_rooms
  SET host_present = p_present, updated_at = NOW()
  WHERE id = p_room_id;

  -- Also update session
  UPDATE public.live_room_sessions
  SET host_present = p_present, updated_at = NOW()
  WHERE id = (SELECT current_session_id FROM public.live_rooms WHERE id = p_room_id);

  RETURN jsonb_build_object('ok', true, 'host_present', p_present);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- live_room_end_session
CREATE OR REPLACE FUNCTION public.live_room_end_session(p_room_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_room RECORD;
BEGIN
  SELECT * INTO v_room FROM public.live_rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND');
  END IF;
  IF NOT public.live_room_is_host(p_room_id, auth.uid()) THEN
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

-- live_room_get_lobby
CREATE OR REPLACE FUNCTION public.live_room_get_lobby(p_room_id UUID)
RETURNS JSONB AS $$
BEGIN
  IF NOT public.live_room_is_host(p_room_id, auth.uid()) THEN
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

-- live_room_admit_user
CREATE OR REPLACE FUNCTION public.live_room_admit_user(p_room_id UUID, p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_session_id UUID;
BEGIN
  IF NOT public.live_room_is_host(p_room_id, auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  SELECT current_session_id INTO v_session_id FROM public.live_rooms WHERE id = p_room_id;

  UPDATE public.live_room_attendance
  SET lobby_status = 'admitted'
  WHERE session_id = v_session_id AND user_id = p_user_id AND lobby_status = 'waiting' AND left_at IS NULL;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- live_room_reject_user
CREATE OR REPLACE FUNCTION public.live_room_reject_user(p_room_id UUID, p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_session_id UUID;
BEGIN
  IF NOT public.live_room_is_host(p_room_id, auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  SELECT current_session_id INTO v_session_id FROM public.live_rooms WHERE id = p_room_id;

  UPDATE public.live_room_attendance
  SET lobby_status = 'rejected'
  WHERE session_id = v_session_id AND user_id = p_user_id AND lobby_status = 'waiting' AND left_at IS NULL;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- live_room_admit_all
CREATE OR REPLACE FUNCTION public.live_room_admit_all(p_room_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_session_id UUID;
  v_count INT;
BEGIN
  IF NOT public.live_room_is_host(p_room_id, auth.uid()) THEN
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

-- live_room_kick_user
CREATE OR REPLACE FUNCTION public.live_room_kick_user(p_room_id UUID, p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_session_id UUID;
BEGIN
  IF NOT public.live_room_is_host(p_room_id, auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  -- A co-host cannot remove the creator or another co-host; the creator can still remove a co-host.
  IF public.live_room_is_host(p_room_id, p_user_id)
     AND NOT EXISTS (SELECT 1 FROM public.live_rooms WHERE id = p_room_id AND host_user_id = auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TARGET_IS_HOST');
  END IF;

  SELECT current_session_id INTO v_session_id FROM public.live_rooms WHERE id = p_room_id;

  UPDATE public.live_room_attendance
  SET left_at = NOW()
  WHERE session_id = v_session_id AND user_id = p_user_id AND left_at IS NULL;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- live_room_ban_user
CREATE OR REPLACE FUNCTION public.live_room_ban_user(p_room_id UUID, p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_session_id UUID;
BEGIN
  IF NOT public.live_room_is_host(p_room_id, auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_HOST');
  END IF;

  -- A co-host cannot remove the creator or another co-host; the creator can still remove a co-host.
  IF public.live_room_is_host(p_room_id, p_user_id)
     AND NOT EXISTS (SELECT 1 FROM public.live_rooms WHERE id = p_room_id AND host_user_id = auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TARGET_IS_HOST');
  END IF;

  SELECT current_session_id INTO v_session_id FROM public.live_rooms WHERE id = p_room_id;

  UPDATE public.live_room_attendance
  SET left_at = NOW(), is_banned = true
  WHERE session_id = v_session_id AND user_id = p_user_id AND left_at IS NULL;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- live_room_join_session
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
  IF public.live_room_is_host(p_room_id, v_user_id) THEN
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

-- live_room_get_state
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
        'role', COALESCE(a.role, CASE WHEN public.live_room_is_host(p_room_id, v_viewer_user_id) THEN 'host' ELSE NULL END),
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
          'role', CASE WHEN public.live_room_is_host(p_room_id, v_viewer_user_id) THEN 'host' ELSE NULL END,
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

-- live_room_check_access (3 params)
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

  -- A listed co-host of this room needs no access grant either.
  IF public.live_room_is_host(p_room_id, p_user_id) THEN
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

-- live_room_update_metadata
CREATE OR REPLACE FUNCTION live_room_update_metadata(
  p_live_room_id UUID,
  p_metadata JSONB
) RETURNS BOOLEAN AS $$
BEGIN
  UPDATE live_rooms
  SET metadata = p_metadata, updated_at = NOW()
  WHERE id = p_live_room_id
    AND public.live_room_is_host(id, auth.uid()); -- creator or listed co-host

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;
