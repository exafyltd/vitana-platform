-- VTID-05493 fixture: five tenants (maxina default + open_signup, t-a, t-b, platform, t-c) and seven users.
-- Loaded BEFORE the lane migrations so the 070300 snapshot captures these rows.
INSERT INTO public.tenants (tenant_id, slug, name, is_active, open_signup, is_default, is_platform) VALUES
 ('00000000-0000-0000-0000-0000000000a0', 'maxina',   'Maxina',   true, true,  true,  false),
 ('00000000-0000-0000-0000-0000000000a1', 't-a',      'Tenant A', true, false, false, false),
 ('00000000-0000-0000-0000-0000000000a2', 't-b',      'Tenant B', true, false, false, false),
 ('00000000-0000-0000-0000-0000000000a3', 'platform', 'Platform', true, false, false, true),
 ('00000000-0000-0000-0000-0000000000a4', 't-c',      'Tenant C', true, false, false, false);
INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES
 ('00000000-0000-0000-0000-0000000000c0', 'u0@example.test',  '{}'),   -- member of maxina only
 ('00000000-0000-0000-0000-0000000000c1', 'ua@example.test',  '{}'),   -- member of t-a only
 ('00000000-0000-0000-0000-0000000000c2', 'uab@example.test', '{}'),   -- member of t-a and t-b
 ('00000000-0000-0000-0000-0000000000c3', 'ux@example.test',  '{}'),   -- member of nothing
 ('00000000-0000-0000-0000-0000000000c4', 'ue@example.test',  '{"exafy_admin":"true"}'),
 ('00000000-0000-0000-0000-0000000000c5', 'uc@example.test',  '{}'),   -- member of t-c only
 ('00000000-0000-0000-0000-0000000000c6', 'uam@example.test', '{}');   -- member of t-a and maxina
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
 ('00000000-0000-0000-0000-0000000000a0', '00000000-0000-0000-0000-0000000000c0', true),
 ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', true),
 ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2', true),
 ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c2', false),
 ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000c5', true),
 ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c6', true),
 ('00000000-0000-0000-0000-0000000000a0', '00000000-0000-0000-0000-0000000000c6', false);
INSERT INTO public.memberships (user_id, tenant_id, role)
 SELECT user_id, tenant_id, 'community' FROM public.user_tenants;
