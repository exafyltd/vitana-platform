-- Vitana ID — Release A · 8/9
-- Replace handle_new_user() so new signups get a vitana_id from day one.
--
-- IMPORTANT: this preserves every side-effect of the previous version
-- (migration 20260122161652_e7be894e-d4dc-43c8-90a9-518c1b6ac83f.sql):
--
--   1. INSERT INTO profiles  (with display_name + handle + email)
--   2. INSERT INTO global_community_profiles
--   3. Tenant resolution by raw_user_meta_data.tenant_slug -> tenants.tenant_id
--      (or fallback to oldest tenant)
--   4. INSERT INTO memberships  (role 'community', status 'active')
--   5. INSERT INTO role_preferences  (role 'community')
--   6. UPDATE auth.users.raw_app_meta_data with active_tenant_id
--
-- Changes vs the old version:
--   - Generate vitana_id via generate_vitana_id_suggestion()
--   - Set handle = vitana_id (replace policy — handle column is now a mirror)
--   - Set vitana_id_locked = false (false = "new user has not yet confirmed
--     their pick on the onboarding card"; the /vitana-id/confirm endpoint
--     flips this to true once they accept or change the suggestion)
--   - Mirror trigger (5/9) propagates vitana_id to app_users automatically
--
-- The separate trigger generate_maxina_discount_code (from migration
-- 20260210141933) is untouched — it still fires AFTER this trigger.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_slug    text;
  v_tenant_id      uuid;
  v_full_name      text;
  v_display_name   text;
  v_email          text;
  v_vitana_id      text;
BEGIN
  -- Read sign-up metadata.
  v_tenant_slug  := NEW.raw_user_meta_data ->> 'tenant_slug';
  v_full_name    := NEW.raw_user_meta_data ->> 'full_name';
  v_email        := NEW.email;
  v_display_name := COALESCE(
    NEW.raw_user_meta_data ->> 'display_name',
    v_full_name,
    split_part(v_email, '@', 1)
  );

  -- Generate canonical vitana_id (also acts as initial handle under the
  -- replace policy). The user can change it once via the onboarding card,
  -- which writes the previous value to handle_aliases and locks.
  v_vitana_id := public.generate_vitana_id_suggestion(v_display_name, v_full_name, v_email);

  -- Profile row. Mirror trigger fires AFTER INSERT and propagates vitana_id
  -- to app_users.vitana_id (only if app_users row already exists; for users
  -- whose app_users row is created later by the gateway auto-provision,
  -- the trigger is a no-op here and the gateway-side INSERT is responsible
  -- for fetching the canonical vitana_id from profiles.).
  INSERT INTO public.profiles (
    user_id, full_name, display_name, handle, email, vitana_id, vitana_id_locked
  ) VALUES (
    NEW.id,
    v_full_name,
    v_display_name,
    v_vitana_id,    -- handle = vitana_id under replace policy
    v_email,
    v_vitana_id,
    false           -- not yet confirmed on onboarding card
  );

  -- Global community profile (preserved from prior version).
  INSERT INTO public.global_community_profiles (user_id, display_name, is_visible)
  VALUES (NEW.id, v_display_name, true)
  ON CONFLICT (user_id) DO NOTHING;

  -- Tenant resolution (preserved logic, including fallback to oldest tenant).
  IF v_tenant_slug IS NOT NULL THEN
    SELECT t.tenant_id INTO v_tenant_id
      FROM public.tenants t
     WHERE t.slug = v_tenant_slug
     LIMIT 1;
  END IF;

  IF v_tenant_id IS NULL THEN
    SELECT t.tenant_id INTO v_tenant_id
      FROM public.tenants t
     ORDER BY t.created_at ASC
     LIMIT 1;
  END IF;

  IF v_tenant_id IS NOT NULL THEN
    INSERT INTO public.memberships (user_id, tenant_id, role, status)
    VALUES (NEW.id, v_tenant_id, 'community'::public.tenant_role, 'active');

    INSERT INTO public.role_preferences (user_id, tenant_id, role)
    VALUES (NEW.id, v_tenant_id, 'community');

    UPDATE auth.users
       SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                            || jsonb_build_object('active_tenant_id', v_tenant_id)
     WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'Provisions a new user: profile (with vitana_id), global community profile, tenant membership, role preference, active_tenant_id metadata. Replaces the prior version from 20260122161652. Mirror trigger propagates vitana_id to app_users.';
