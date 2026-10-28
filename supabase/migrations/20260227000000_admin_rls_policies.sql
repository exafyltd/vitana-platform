-- Admin RLS Policies
-- Allows users with exafy_admin=true in app_metadata to SELECT all rows
-- across admin-relevant tables. This powers the Maxina Admin dashboard.
--
-- The exafy_admin flag is set via Gateway dev-access endpoints and is
-- already used for admin auth in the Gateway middleware (verifyExafyAdmin).

-- Helper: reusable admin check expression
-- (auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE

-- 1. app_users (Dashboard, Users & Growth)
CREATE POLICY admin_read_all_app_users ON public.app_users
  FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);

-- 2. user_tenants (Users & Growth - joined with app_users)
CREATE POLICY admin_read_all_user_tenants ON public.user_tenants
  FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);

-- 3. signup_attempts (Dashboard, Signup Funnel)
DO $$ BEGIN
  CREATE POLICY admin_read_all_signup_attempts ON public.signup_attempts
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN undefined_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;

-- 4. onboarding_invitations (Invitations tab)
DO $$ BEGIN
  CREATE POLICY admin_read_all_onboarding_invitations ON public.onboarding_invitations
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN undefined_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;

-- 5. user_notifications (Notifications Sent Log, Dashboard)
CREATE POLICY admin_read_all_user_notifications ON public.user_notifications
  FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);

-- 6. user_notification_preferences (Notifications Preferences)
DO $$ BEGIN
  CREATE POLICY admin_read_all_notification_prefs ON public.user_notification_preferences
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN undefined_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;

-- 7. live_rooms (Live Rooms - already has tenant SELECT, adding admin bypass)
CREATE POLICY admin_read_all_live_rooms ON public.live_rooms
  FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);

-- 8. live_room_sessions (Live Sessions)
CREATE POLICY admin_read_all_live_room_sessions ON public.live_room_sessions
  FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);

-- 9. live_room_attendance (Live Attendance)
DO $$ BEGIN
  CREATE POLICY admin_read_all_live_room_attendance ON public.live_room_attendance
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN undefined_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;

-- 10. memory_items (Intelligence Memory, Embeddings)
CREATE POLICY admin_read_all_memory_items ON public.memory_items
  FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);

-- 11. memory_facts (Intelligence Memory, Embeddings)
CREATE POLICY admin_read_all_memory_facts ON public.memory_facts
  FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);

-- 12. oasis_events_v1 (Audit Events, User Activity, Security)
DO $$ BEGIN
  CREATE POLICY admin_read_all_oasis_events ON public.oasis_events_v1
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN undefined_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;

-- 13. system_controls (System Configuration)
DO $$ BEGIN
  CREATE POLICY admin_read_all_system_controls ON public.system_controls
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN undefined_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;

-- 14. creator_profiles (System Creators)
DO $$ BEGIN
  CREATE POLICY admin_read_all_creator_profiles ON public.creator_profiles
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN undefined_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;

-- 15. d44_predictive_signals (Intelligence Signals)
DO $$ BEGIN
  CREATE POLICY admin_read_all_predictive_signals ON public.d44_predictive_signals
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN undefined_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;

-- 16. relationship_nodes (Intelligence Relationships)
DO $$ BEGIN
  CREATE POLICY admin_read_all_relationship_nodes ON public.relationship_nodes
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN undefined_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;

-- 17. relationship_edges (Intelligence Relationships)
DO $$ BEGIN
  CREATE POLICY admin_read_all_relationship_edges ON public.relationship_edges
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN undefined_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;

-- 18. community_groups (Community)
DO $$ BEGIN
  CREATE POLICY admin_read_all_community_groups ON public.community_groups
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN undefined_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;

-- 19. community_meetups (Community Meetups)
DO $$ BEGIN
  CREATE POLICY admin_read_all_community_meetups ON public.community_meetups
    FOR SELECT TO authenticated
    USING ((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean IS TRUE);
EXCEPTION WHEN undefined_table THEN NULL;
         WHEN duplicate_object THEN NULL;
END $$;
