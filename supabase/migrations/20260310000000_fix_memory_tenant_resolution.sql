-- =============================================================================
-- Migration: 20260310000000_fix_memory_tenant_resolution.sql
-- VTID-MEMORY-BRIDGE: Fix tenant_id resolution for memory system
-- Date: 2026-03-10
--
-- Problem: provision_platform_user() creates user_tenants rows but does NOT
--   set active_tenant_id in auth.users.raw_app_meta_data. This means the
--   gateway's JWT extraction gets tenant_id=null, and ORB sessions fall back
--   to DEV_IDENTITY or skip memory entirely. Memory writes via SQL RPCs work
--   (current_tenant_id() has a user_tenants fallback), but reads via the
--   gateway use the JWT-extracted tenant_id — causing a data mismatch.
--
-- Fixes:
--   A. Update provision_platform_user() to set active_tenant_id in raw_app_meta_data
--   B. Backfill existing users who have user_tenants but missing active_tenant_id
-- =============================================================================

BEGIN;

-- =============================================================================
-- A. Update provision_platform_user() to set active_tenant_id in JWT metadata
-- =============================================================================

CREATE OR REPLACE FUNCTION public.provision_platform_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_slug TEXT;
    v_tenant_id UUID;
    v_display_name TEXT;
    v_email TEXT;
BEGIN
    v_email := NEW.email;
    v_tenant_slug := NEW.raw_user_meta_data ->> 'tenant_slug';

    -- Derive display name
    v_display_name := COALESCE(
        NEW.raw_user_meta_data ->> 'display_name',
        NEW.raw_user_meta_data ->> 'full_name',
        split_part(v_email, '@', 1)
    );

    -- Resolve tenant by slug
    IF v_tenant_slug IS NOT NULL THEN
        SELECT t.tenant_id INTO v_tenant_id
        FROM public.tenants t
        WHERE t.slug = v_tenant_slug
        LIMIT 1;
    END IF;

    -- Fallback: oldest tenant
    IF v_tenant_id IS NULL THEN
        SELECT t.tenant_id INTO v_tenant_id
        FROM public.tenants t
        ORDER BY t.created_at ASC
        LIMIT 1;
    END IF;

    -- Create app_users row (the backend user registry)
    INSERT INTO public.app_users (user_id, email, display_name, tenant_id)
    VALUES (NEW.id, v_email, v_display_name, v_tenant_id)
    ON CONFLICT (user_id) DO UPDATE SET
        email = EXCLUDED.email,
        display_name = COALESCE(EXCLUDED.display_name, public.app_users.display_name),
        tenant_id = COALESCE(EXCLUDED.tenant_id, public.app_users.tenant_id),
        updated_at = NOW();

    -- Create user_tenants row (is_primary=true triggers live room creation)
    IF v_tenant_id IS NOT NULL THEN
        INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
        VALUES (v_tenant_id, NEW.id, 'community', true)
        ON CONFLICT (tenant_id, user_id) DO NOTHING;

        -- VTID-MEMORY-BRIDGE: Set active_tenant_id in JWT app_metadata so the
        -- gateway can extract it without a DB lookup. Without this, the gateway
        -- gets tenant_id=null and ORB memory reads/writes fail.
        UPDATE auth.users
        SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
            || jsonb_build_object('active_tenant_id', v_tenant_id::TEXT)
        WHERE id = NEW.id
          AND (raw_app_meta_data->>'active_tenant_id') IS NULL;
    END IF;

    RETURN NEW;
END;
$$;

-- Ensure trigger exists (idempotent)
DROP TRIGGER IF EXISTS on_auth_user_platform_provision ON auth.users;
CREATE TRIGGER on_auth_user_platform_provision
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.provision_platform_user();

-- =============================================================================
-- B. Backfill: set active_tenant_id for existing users missing it
-- =============================================================================
-- Users who signed up before this fix have user_tenants rows but their JWT
-- metadata never had active_tenant_id set. This backfill fixes all of them.

UPDATE auth.users u
SET raw_app_meta_data = COALESCE(u.raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('active_tenant_id', ut.tenant_id::TEXT)
FROM public.user_tenants ut
WHERE ut.user_id = u.id
  AND ut.is_primary = true
  AND (u.raw_app_meta_data IS NULL OR (u.raw_app_meta_data->>'active_tenant_id') IS NULL);

COMMIT;
