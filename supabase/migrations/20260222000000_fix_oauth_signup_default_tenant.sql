-- =============================================================================
-- Fix: OAuth signups (Google/Apple) default to maxina tenant
-- =============================================================================
-- Problem: When users sign up via Google/Apple OAuth on vitanaland.com/maxina,
-- the provision_platform_user trigger cannot determine the tenant because:
--   - Email/password signups pass tenant_slug in raw_user_meta_data.data → works
--   - OAuth signups pass tenant_slug as queryParams → goes to Google URL, NOT
--     stored in raw_user_meta_data → trigger falls back to "oldest tenant"
--     which is earthlings, not maxina
--
-- Fix: Change the fallback from "oldest tenant" to "maxina" since:
--   - vitanaland.com and vitanaland.com/maxina are Maxina registrations
--   - Maxina is the primary/default tenant
--   - Other portals (alkalma, earthlinks) use email/password signup which
--     correctly sets tenant_slug in raw_user_meta_data
-- =============================================================================

BEGIN;

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

    -- Resolve tenant from signup metadata (works for email/password signups)
    IF v_tenant_slug IS NOT NULL THEN
        SELECT t.tenant_id INTO v_tenant_id
        FROM public.tenants t
        WHERE t.slug = v_tenant_slug
        LIMIT 1;
    END IF;

    -- Fallback: default to maxina (primary tenant)
    -- This handles OAuth signups (Google/Apple) where tenant_slug is not
    -- available in raw_user_meta_data because queryParams don't get stored there.
    -- All vitanaland.com registrations are maxina registrations.
    IF v_tenant_id IS NULL THEN
        SELECT t.tenant_id INTO v_tenant_id
        FROM public.tenants t
        WHERE t.slug = 'maxina'
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

COMMENT ON FUNCTION public.provision_platform_user IS
  'Auto-provision app_users + user_tenants on signup. Defaults to maxina for OAuth signups where tenant_slug is not in metadata.';

COMMIT;
