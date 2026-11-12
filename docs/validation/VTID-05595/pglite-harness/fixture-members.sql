-- Harness-only seed for checks.sh (never part of the pgTAP file): two tenants, an ab_dual member, a single-primary member.
INSERT INTO public.tenants (slug, name) VALUES ('chk-a', 'chk-a'), ('chk-b', 'chk-b');
INSERT INTO public.app_users (user_id, email) VALUES ('00000000-0000-4000-8000-000000000001', 'c1@example.invalid'), ('00000000-0000-4000-8000-000000000002', 'c2@example.invalid');
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
SELECT t.tenant_id, '00000000-0000-4000-8000-000000000001', t.slug = 'chk-a' FROM public.tenants t;
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
SELECT t.tenant_id, '00000000-0000-4000-8000-000000000002', true FROM public.tenants t WHERE t.slug = 'chk-b';
