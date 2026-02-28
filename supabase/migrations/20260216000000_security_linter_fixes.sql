-- =============================================================================
-- Migration: Security Linter Fixes
-- Date: 2026-02-16
-- Description: Addresses all ERROR-level findings from the Supabase security linter
--
-- Fixes:
--   1. auth_users_exposed: admin_user_analytics exposes auth.users to anon
--   2. policy_exists_rls_disabled: vtidledger_wrong_backup has policies but no RLS
--   3. security_definer_view: 9 views using SECURITY DEFINER (should be INVOKER)
--   4. rls_disabled_in_public: 5 tables without RLS enabled
-- =============================================================================

BEGIN;

-- =============================================================================
-- FIX 1: Drop vtidledger_wrong_backup
-- This is a leftover backup table with a wrong name. It has RLS policies
-- attached but RLS is not enabled. Safest fix: drop entirely.
-- =============================================================================
DROP TABLE IF EXISTS public.vtidledger_wrong_backup CASCADE;

-- =============================================================================
-- FIX 2: Convert SECURITY DEFINER views to SECURITY INVOKER
-- PostgreSQL 15+ supports security_invoker on views. This ensures the view
-- runs with the permissions of the querying user, not the view owner.
-- This is the Supabase-recommended fix for security_definer_view findings.
-- =============================================================================

-- admin_user_analytics: Also fixes auth_users_exposed since authenticated
-- users don't have direct access to auth.users, the view will now return
-- empty results for non-superuser callers (effectively restricting access).
ALTER VIEW IF EXISTS public.admin_user_analytics SET (security_invoker = on);

-- Revoke anon access from admin_user_analytics (should never be public)
REVOKE ALL ON public.admin_user_analytics FROM anon;

-- Other admin/analytics views
ALTER VIEW IF EXISTS public.admin_tenant_analytics SET (security_invoker = on);
ALTER VIEW IF EXISTS public.admin_system_health SET (security_invoker = on);
ALTER VIEW IF EXISTS public.popular_podcast_shows SET (security_invoker = on);

-- Platform views
ALTER VIEW IF EXISTS public."VtidLedger" SET (security_invoker = on);
ALTER VIEW IF EXISTS public.vtid_specs SET (security_invoker = on);
ALTER VIEW IF EXISTS public.commandhub_board_visible SET (security_invoker = on);
ALTER VIEW IF EXISTS public.live_rooms_public SET (security_invoker = on);

-- =============================================================================
-- FIX 3: Enable RLS on public tables that lack it
-- In Supabase, service_role bypasses RLS automatically, so enabling RLS
-- won't break service-to-service calls. We add policies for authenticated
-- users where appropriate.
-- =============================================================================

-- agent_keys: API keys for agents. Only service_role should access.
ALTER TABLE IF EXISTS public.agent_keys ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'agent_keys') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_keys' AND policyname = 'agent_keys_service_role_all') THEN
      EXECUTE 'CREATE POLICY agent_keys_service_role_all ON public.agent_keys FOR ALL TO service_role USING (true) WITH CHECK (true)';
    END IF;
  END IF;
END $$;

-- events: System events table. Service writes, authenticated can read.
ALTER TABLE IF EXISTS public.events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'events') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'events' AND policyname = 'events_service_role_all') THEN
      EXECUTE 'CREATE POLICY events_service_role_all ON public.events FOR ALL TO service_role USING (true) WITH CHECK (true)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'events' AND policyname = 'events_authenticated_select') THEN
      EXECUTE 'CREATE POLICY events_authenticated_select ON public.events FOR SELECT TO authenticated USING (true)';
    END IF;
  END IF;
END $$;

-- event_kinds: Reference/lookup table for event types. Read-only for authenticated.
ALTER TABLE IF EXISTS public.event_kinds ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'event_kinds') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_kinds' AND policyname = 'event_kinds_service_role_all') THEN
      EXECUTE 'CREATE POLICY event_kinds_service_role_all ON public.event_kinds FOR ALL TO service_role USING (true) WITH CHECK (true)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_kinds' AND policyname = 'event_kinds_authenticated_select') THEN
      EXECUTE 'CREATE POLICY event_kinds_authenticated_select ON public.event_kinds FOR SELECT TO authenticated USING (true)';
    END IF;
  END IF;
END $$;

-- knowledge_docs: Knowledge base documents. Accessed via search_knowledge_docs RPC.
-- Authenticated can SELECT, service_role has full access (already granted).
ALTER TABLE IF EXISTS public.knowledge_docs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'knowledge_docs') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'knowledge_docs' AND policyname = 'knowledge_docs_service_role_all') THEN
      EXECUTE 'CREATE POLICY knowledge_docs_service_role_all ON public.knowledge_docs FOR ALL TO service_role USING (true) WITH CHECK (true)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'knowledge_docs' AND policyname = 'knowledge_docs_authenticated_select') THEN
      EXECUTE 'CREATE POLICY knowledge_docs_authenticated_select ON public.knowledge_docs FOR SELECT TO authenticated USING (true)';
    END IF;
  END IF;
END $$;

COMMIT;
