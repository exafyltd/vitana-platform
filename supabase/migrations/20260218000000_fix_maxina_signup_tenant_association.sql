-- =============================================================================
-- Fix: Maxina signup tenant association
-- =============================================================================
-- Problem: Users registering via /maxina (vitanaland.com/maxina) cannot create
-- live rooms or sessions. They get TENANT_NOT_FOUND errors.
--
-- Root causes:
--   1. current_tenant_id() does not check app_metadata.active_tenant_id from JWT
--      (the frontend sets this during signup via handle_new_user trigger)
--   2. No app_users or user_tenants rows are created on signup — the frontend
--      trigger creates "memberships" rows, but the backend checks "user_tenants"
--   3. app_users.tenant_id column doesn't exist (referenced by live_room_create)
--
-- Fixes:
--   A. Update current_tenant_id() to also check app_metadata.active_tenant_id
--   B. Add tenant_id column to app_users
--   C. Create AFTER INSERT trigger on auth.users to auto-provision app_users +
--      user_tenants rows (with is_primary=true so live room trigger fires)
--   D. Backfill existing users who have auth.users rows but no app_users/user_tenants
-- =============================================================================

BEGIN;

-- =============================================================================
-- A. Fix current_tenant_id() to check app_metadata.active_tenant_id
-- =============================================================================
-- Standard Supabase JWTs include app_metadata as a nested object in the JWT
-- claims. The frontend's handle_new_user trigger sets active_tenant_id there.
-- After signup + email confirm + login, the JWT will contain:
--   { "app_metadata": { "active_tenant_id": "<uuid>" }, ... }
-- We need current_tenant_id() to find it.

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_tenant_id UUID;
    v_jwt_claims JSONB;
BEGIN
    -- Priority 1: Request context GUC (set by dev_bootstrap or backend middleware)
    BEGIN
        v_tenant_id := current_setting('request.tenant_id', true)::UUID;
        IF v_tenant_id IS NOT NULL THEN
            RETURN v_tenant_id;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- Priority 2: JWT claims
    BEGIN
        v_jwt_claims := current_setting('request.jwt.claims', true)::JSONB;
        IF v_jwt_claims IS NOT NULL THEN
            -- Try top-level tenant_id claim
            v_tenant_id := (v_jwt_claims->>'tenant_id')::UUID;
            IF v_tenant_id IS NOT NULL THEN
                RETURN v_tenant_id;
            END IF;

            -- Try top-level tenant claim
            v_tenant_id := (v_jwt_claims->>'tenant')::UUID;
            IF v_tenant_id IS NOT NULL THEN
                RETURN v_tenant_id;
            END IF;

            -- Try app_metadata.active_tenant_id (set by frontend handle_new_user trigger)
            v_tenant_id := (v_jwt_claims->'app_metadata'->>'active_tenant_id')::UUID;
            IF v_tenant_id IS NOT NULL THEN
                RETURN v_tenant_id;
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- Priority 3: Fall back to user_tenants table (primary tenant)
    BEGIN
        SELECT tenant_id INTO v_tenant_id
        FROM public.user_tenants
        WHERE user_id = auth.uid()
          AND is_primary = true
        LIMIT 1;
        IF v_tenant_id IS NOT NULL THEN
            RETURN v_tenant_id;
        END IF;

        -- Any tenant for this user
        SELECT tenant_id INTO v_tenant_id
        FROM public.user_tenants
        WHERE user_id = auth.uid()
        LIMIT 1;
        IF v_tenant_id IS NOT NULL THEN
            RETURN v_tenant_id;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO service_role;

COMMENT ON FUNCTION public.current_tenant_id IS
  'Get tenant_id from: (1) request GUC, (2) JWT tenant_id/tenant, (3) JWT app_metadata.active_tenant_id, (4) user_tenants table';

-- =============================================================================
-- B. Add tenant_id column to app_users (referenced by live_room_create)
-- =============================================================================

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(tenant_id) ON DELETE SET NULL;

COMMENT ON COLUMN public.app_users.tenant_id IS 'Primary tenant for this user (denormalized from user_tenants for convenience)';

-- =============================================================================
-- C. Auto-provision app_users + user_tenants on new signup
-- =============================================================================
-- This trigger fires AFTER INSERT on auth.users. It reads tenant_slug from
-- raw_user_meta_data (set by the frontend signUp call) and creates the backend
-- records needed for live rooms, sessions, and all tenant-scoped features.
--
-- The existing trigger on user_tenants (trg_create_user_live_room) will then
-- automatically create the user's permanent live room.

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

    -- Resolve tenant
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
    END IF;

    RETURN NEW;
END;
$$;

-- Trigger name sorts after on_auth_user_created (frontend) so it fires second
DROP TRIGGER IF EXISTS on_auth_user_platform_provision ON auth.users;
CREATE TRIGGER on_auth_user_platform_provision
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.provision_platform_user();

COMMENT ON FUNCTION public.provision_platform_user IS
  'Auto-provision app_users + user_tenants when a new user signs up. Enables live rooms and all tenant-scoped features.';

-- =============================================================================
-- D. Backfill existing users who have auth.users but no app_users/user_tenants
-- =============================================================================
-- This catches users like daniela.kueper@gmx.de who already registered but
-- couldn't use live rooms because they had no backend records.

DO $$
DECLARE
    v_user RECORD;
    v_tenant_slug TEXT;
    v_tenant_id UUID;
    v_display_name TEXT;
    v_count INT := 0;
BEGIN
    FOR v_user IN
        SELECT au.id, au.email, au.raw_user_meta_data
        FROM auth.users au
        LEFT JOIN public.app_users pu ON pu.user_id = au.id
        WHERE pu.user_id IS NULL
    LOOP
        v_tenant_slug := v_user.raw_user_meta_data ->> 'tenant_slug';
        v_tenant_id := NULL;

        -- Derive display name
        v_display_name := COALESCE(
            v_user.raw_user_meta_data ->> 'display_name',
            v_user.raw_user_meta_data ->> 'full_name',
            split_part(v_user.email, '@', 1)
        );

        -- Resolve tenant from slug
        IF v_tenant_slug IS NOT NULL THEN
            SELECT id INTO v_tenant_id
            FROM public.tenants
            WHERE slug = v_tenant_slug
            LIMIT 1;
        END IF;

        -- Fallback: oldest tenant
        IF v_tenant_id IS NULL THEN
            SELECT id INTO v_tenant_id
            FROM public.tenants
            ORDER BY created_at ASC
            LIMIT 1;
        END IF;

        -- Create app_users
        INSERT INTO public.app_users (user_id, email, display_name, tenant_id)
        VALUES (v_user.id, v_user.email, v_display_name, v_tenant_id)
        ON CONFLICT (user_id) DO UPDATE SET
            tenant_id = COALESCE(EXCLUDED.tenant_id, public.app_users.tenant_id),
            updated_at = NOW();

        -- Create user_tenants (is_primary=true triggers live room creation)
        IF v_tenant_id IS NOT NULL THEN
            INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
            VALUES (v_tenant_id, v_user.id, 'community', true)
            ON CONFLICT (tenant_id, user_id) DO NOTHING;
        END IF;

        v_count := v_count + 1;
    END LOOP;

    RAISE NOTICE 'Backfilled % users into app_users + user_tenants', v_count;
END;
$$;

-- =============================================================================
-- Also backfill user_tenants for users who have app_users but no user_tenants
-- (e.g. users whose app_users row was created by fix-all-live-rooms.sql)
-- =============================================================================

DO $$
DECLARE
    v_user RECORD;
    v_count INT := 0;
BEGIN
    FOR v_user IN
        SELECT au.user_id, au.tenant_id
        FROM public.app_users au
        LEFT JOIN public.user_tenants ut ON ut.user_id = au.user_id
        WHERE ut.user_id IS NULL
          AND au.tenant_id IS NOT NULL
    LOOP
        INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
        VALUES (v_user.tenant_id, v_user.user_id, 'community', true)
        ON CONFLICT (tenant_id, user_id) DO NOTHING;

        v_count := v_count + 1;
    END LOOP;

    RAISE NOTICE 'Backfilled % user_tenants rows for existing app_users', v_count;
END;
$$;

COMMIT;
