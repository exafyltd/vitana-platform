-- Backfill app_users from auth.users
-- The provision_platform_user() trigger was added after existing users signed up,
-- so those users never got app_users rows. This one-time migration fixes that.

INSERT INTO public.app_users (user_id, email, display_name, tenant_id, created_at, updated_at)
SELECT
  au.id,
  au.email,
  COALESCE(
    au.raw_user_meta_data->>'display_name',
    au.raw_user_meta_data->>'full_name',
    au.raw_user_meta_data->>'name',
    split_part(au.email, '@', 1)
  ) AS display_name,
  (SELECT tenant_id FROM public.tenants ORDER BY created_at ASC LIMIT 1),
  au.created_at,
  NOW()
FROM auth.users au
WHERE NOT EXISTS (
  SELECT 1 FROM public.app_users ap WHERE ap.user_id = au.id
);

-- Also backfill user_tenants for users missing tenant membership
-- Uses the default (oldest) tenant as fallback
INSERT INTO public.user_tenants (user_id, tenant_id, active_role, is_primary, created_at)
SELECT
  au.id,
  (SELECT tenant_id FROM public.tenants ORDER BY created_at ASC LIMIT 1),
  'community',
  true,
  NOW()
FROM auth.users au
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = au.id
)
AND EXISTS (
  SELECT 1 FROM public.tenants LIMIT 1
);
