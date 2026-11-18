-- VTID-05491 fixture: rows that exist BEFORE the lane migrations run. Local throwaway database only.
-- Ids: T_A ...a1, T_B ...b1, T_C ...c9 (no flag). Users: uA mod of T_A ...01, uB mod of T_B ...02, uX exafy admin (JWT only) ...03,
-- uR1 member of T_A only ...11, uR2 member of T_B only ...12, uR3 member of both, T_A primary ...13, uR4 member of both, no primary ...14,
-- uR5 no membership ...15.
INSERT INTO public.tenants (tenant_id, slug, name) VALUES
  ('05491000-0000-4000-8000-0000000000a1', 't05491a', 'Tenant A'),
  ('05491000-0000-4000-8000-0000000000b1', 't05491b', 'Tenant B'),
  ('05491000-0000-4000-8000-0000000000c9', 't05491c', 'Tenant C');
INSERT INTO auth.users (id, email) SELECT ('05491000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'u' || n || '@example.test'
  FROM unnest(ARRAY[1,2,3,11,12,13,14,15]) AS n;
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
  ('05491000-0000-4000-8000-0000000000a1', '05491000-0000-4000-8000-000000000011', true),
  ('05491000-0000-4000-8000-0000000000b1', '05491000-0000-4000-8000-000000000012', true),
  ('05491000-0000-4000-8000-0000000000a1', '05491000-0000-4000-8000-000000000013', true),
  ('05491000-0000-4000-8000-0000000000b1', '05491000-0000-4000-8000-000000000013', false),
  ('05491000-0000-4000-8000-0000000000a1', '05491000-0000-4000-8000-000000000014', false),
  ('05491000-0000-4000-8000-0000000000b1', '05491000-0000-4000-8000-000000000014', false);
INSERT INTO public.memberships (user_id, tenant_id, role) VALUES
  ('05491000-0000-4000-8000-000000000001', '05491000-0000-4000-8000-0000000000a1', 'staff'),
  ('05491000-0000-4000-8000-000000000002', '05491000-0000-4000-8000-0000000000b1', 'admin');
INSERT INTO public.profile_posts (id, user_id, tenant_id) VALUES
  ('05491000-0000-4000-8000-0000000000f1', '05491000-0000-4000-8000-000000000011', '05491000-0000-4000-8000-0000000000a1');
-- Reports that exist today (no tenant_id column yet): by uR1 (T_A only), uR3 (primary T_A), uR4 (ambiguous), uR5 (none).
INSERT INTO public.content_reports (id, reporter_user_id, content_type, content_id, reason) VALUES
  ('05491000-0000-4000-8000-0000000001e1', '05491000-0000-4000-8000-000000000011', 'post', '05491000-0000-4000-8000-0000000000f1', 'old report uR1'),
  ('05491000-0000-4000-8000-0000000001e2', '05491000-0000-4000-8000-000000000013', 'post', '05491000-0000-4000-8000-0000000000f1', 'old report uR3'),
  ('05491000-0000-4000-8000-0000000001e3', '05491000-0000-4000-8000-000000000014', 'post', '05491000-0000-4000-8000-0000000000f1', 'old report uR4 ambiguous'),
  ('05491000-0000-4000-8000-0000000001e4', '05491000-0000-4000-8000-000000000015', 'post', '05491000-0000-4000-8000-0000000000f1', 'old report uR5 no membership');
INSERT INTO public.moderation_actions (id, actor_id, action, target_type, target_id, reason) VALUES
  ('05491000-0000-4000-8000-0000000002a1', '05491000-0000-4000-8000-000000000001', 'post_hidden', 'profile_post', '05491000-0000-4000-8000-0000000000f1', 'old post action'),
  ('05491000-0000-4000-8000-0000000002a2', '05491000-0000-4000-8000-000000000001', 'user_suspend', 'user', '05491000-0000-4000-8000-000000000012', 'old user action'),
  ('05491000-0000-4000-8000-0000000002a3', '05491000-0000-4000-8000-000000000001', 'user_suspend', 'user', '05491000-0000-4000-8000-000000000014', 'old user action, ambiguous');
