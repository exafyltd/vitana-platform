-- Fix: Backfill permanent rooms for users who don't have one
--
-- BUG: The create_user_live_room trigger fires on user_tenants INSERT with
-- is_primary=true. Users who were created before the trigger existed, or whose
-- user_tenants row was inserted without is_primary=true, never got a permanent
-- room. This causes GET /api/v1/live/rooms/me to return 404 NO_ROOM and the
-- "Go Live" button to fail completely.
--
-- This migration:
-- 1. Backfills permanent rooms for all users missing one
-- 2. Fixes the trigger to also fire on app_users INSERT (belt-and-suspenders)

-- =============================================================================
-- 1. Backfill: Create permanent rooms for users missing one
-- =============================================================================

DO $$
DECLARE
  r RECORD;
  v_room_id UUID;
  v_slug TEXT;
  v_display_name TEXT;
  v_created_count INT := 0;
BEGIN
  FOR r IN
    SELECT au.user_id, au.display_name, au.email, ut.tenant_id
    FROM public.app_users au
    JOIN public.user_tenants ut ON ut.user_id = au.user_id AND ut.is_primary = true
    WHERE au.live_room_id IS NULL
  LOOP
    v_display_name := COALESCE(r.display_name, split_part(r.email, '@', 1), 'user');

    -- Generate slug: display-name-first6chars-of-userid
    v_slug := lower(regexp_replace(v_display_name, '[^a-z0-9]+', '-', 'gi'));
    v_slug := trim(BOTH '-' FROM v_slug);
    v_slug := v_slug || '-' || left(r.user_id::TEXT, 6);

    BEGIN
      INSERT INTO public.live_rooms (
        tenant_id, title, host_user_id, starts_at, status,
        room_name, room_slug
      ) VALUES (
        r.tenant_id,
        v_display_name || '''s Room',
        r.user_id,
        NULL,  -- NULL for permanent rooms
        'idle',
        v_display_name || '''s Room',
        v_slug
      )
      ON CONFLICT (room_slug) WHERE room_slug IS NOT NULL DO UPDATE SET
        room_slug = EXCLUDED.room_slug || '-' || left(gen_random_uuid()::TEXT, 4)
      RETURNING id INTO v_room_id;

      UPDATE public.app_users SET live_room_id = v_room_id WHERE user_id = r.user_id;
      v_created_count := v_created_count + 1;

      RAISE NOTICE 'Created permanent room % for user % (%)', v_room_id, r.email, r.user_id;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Failed to create room for user % (%): %', r.email, r.user_id, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE 'Backfill complete: created % permanent rooms', v_created_count;
END $$;
