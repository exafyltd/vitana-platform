-- Every value the provisioning wrote, one line per row, ids/timestamps and the
-- random discount code reduced to what they must satisfy. Run with psql -A -t
-- in both databases; the two outputs must be identical. test_active_tenant is
-- a view each side defines: auth.users.raw_app_meta_data on "supabase", the
-- ensure_provisioned() results on "aurora".
SELECT line FROM (
  SELECT format('profiles|%s|%s|%s|%s|%s|%s|%s|%s', user_id, full_name, display_name, handle, email, vitana_id, vitana_id_locked, registration_seq) AS line FROM public.profiles
  UNION ALL SELECT format('global_community_profiles|%s|%s|%s', user_id, display_name, is_visible) FROM public.global_community_profiles
  UNION ALL SELECT format('memberships|%s|%s|%s|%s', user_id, tenant_id, role::text, status) FROM public.memberships
  UNION ALL SELECT format('role_preferences|%s|%s|%s', user_id, tenant_id, role) FROM public.role_preferences
  UNION ALL SELECT format('user_discount_codes|%s|%s|%s|%s|%s|%s|%s', user_id, code ~ '^MAXINA-[A-Z0-9]{6}$', discount_percent, valid_for, tenant_slug, used_at IS NULL, expires_at - created_at) FROM public.user_discount_codes
  UNION ALL SELECT format('user_preferences|%s|%s', user_id, theme) FROM public.user_preferences
  UNION ALL SELECT format('wallet_accounts|%s|%s|%s', user_id, currency, balance_cents) FROM public.wallet_accounts
  UNION ALL SELECT format('app_users|%s|%s|%s|%s', user_id, email, display_name, tenant_id) FROM public.app_users
  UNION ALL SELECT format('user_tenants|%s|%s|%s|%s', tenant_id, user_id, active_role, is_primary) FROM public.user_tenants
  UNION ALL SELECT format('user_permitted_roles|%s|%s|%s|%s', user_id, tenant_id, role, granted_by) FROM public.user_permitted_roles
  UNION ALL SELECT format('user_journey|%s|%s|%s|%s|%s|%s', user_id, onboarding_stage, experience_level, engagement_score, days_active, milestones) FROM public.user_journey
  UNION ALL SELECT format('active_tenant_id|%s|%s', user_id, active_tenant_id) FROM public.test_active_tenant
) s ORDER BY line;
