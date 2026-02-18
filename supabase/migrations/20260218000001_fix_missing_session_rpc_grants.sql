-- Fix: Missing GRANT EXECUTE on all session management RPCs
--
-- BUG: Migration 20260210100000_vtid_01228_live_room_session_mgmt.sql created
-- 19 new RPC functions but never granted EXECUTE to 'authenticated' or
-- 'service_role'. Supabase revokes PUBLIC execute by default, so no user
-- could call any session management function — 100% of "Go Live" attempts
-- failed with PostgreSQL error 42501 (permission denied).
--
-- This migration adds the missing grants for all session management RPCs.

-- Session lifecycle (user-facing)
GRANT EXECUTE ON FUNCTION public.live_room_create_session(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_create_session(UUID, JSONB) TO service_role;

GRANT EXECUTE ON FUNCTION public.live_room_transition_status(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_transition_status(UUID, TEXT, TEXT) TO service_role;

GRANT EXECUTE ON FUNCTION public.live_room_end_session(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_end_session(UUID) TO service_role;

GRANT EXECUTE ON FUNCTION public.live_room_set_host_present(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_set_host_present(UUID, BOOLEAN) TO service_role;

-- Join / participation
GRANT EXECUTE ON FUNCTION public.live_room_join_session(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_join_session(UUID, UUID) TO service_role;

GRANT EXECUTE ON FUNCTION public.live_room_disconnect(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_disconnect(UUID) TO service_role;

-- Lobby management (host-only, but auth checked inside function)
GRANT EXECUTE ON FUNCTION public.live_room_get_lobby(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_get_lobby(UUID) TO service_role;

GRANT EXECUTE ON FUNCTION public.live_room_admit_user(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_admit_user(UUID, UUID) TO service_role;

GRANT EXECUTE ON FUNCTION public.live_room_reject_user(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_reject_user(UUID, UUID) TO service_role;

GRANT EXECUTE ON FUNCTION public.live_room_admit_all(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_admit_all(UUID) TO service_role;

GRANT EXECUTE ON FUNCTION public.live_room_kick_user(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_kick_user(UUID, UUID) TO service_role;

GRANT EXECUTE ON FUNCTION public.live_room_ban_user(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_ban_user(UUID, UUID) TO service_role;

-- Read-only state queries
GRANT EXECUTE ON FUNCTION public.live_room_get_counts(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_get_counts(UUID) TO service_role;

GRANT EXECUTE ON FUNCTION public.live_room_get_state(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_get_state(UUID, UUID) TO service_role;

GRANT EXECUTE ON FUNCTION public.live_room_get_sessions(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_get_sessions(UUID) TO service_role;

GRANT EXECUTE ON FUNCTION public.live_room_update_room_name(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_room_update_room_name(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- Internal / service-role-only (refund & grant management)
GRANT EXECUTE ON FUNCTION public.live_room_get_paid_grants(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.live_room_update_grant_refund(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.live_room_invalidate_session_grants(UUID) TO service_role;
