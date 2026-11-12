-- Harness-only seed for the guard proof: one member with two primary rows, one with none.
INSERT INTO public.tenants (slug, name) VALUES ('chk-a', 'chk-a'), ('chk-b', 'chk-b');
INSERT INTO public.app_users (user_id, email) VALUES ('00000000-0000-4000-8000-000000000003', 'c3@example.invalid'), ('00000000-0000-4000-8000-000000000004', 'c4@example.invalid');
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
SELECT t.tenant_id, '00000000-0000-4000-8000-000000000003', true FROM public.tenants t;
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
SELECT t.tenant_id, '00000000-0000-4000-8000-000000000004', false FROM public.tenants t WHERE t.slug = 'chk-a';
