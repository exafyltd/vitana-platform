-- VTID-05150 fixture, part 2 (after Lane A M1, which expects exactly 2 tenants):
-- a hand-made tenant (never provisioned, not a reserved slug) that already
-- holds the 16 baseline controls, as any tenant created before the type
-- migrations would.
INSERT INTO public.tenants (tenant_id, name, slug) VALUES ('b0000000-0000-4000-8000-000000000001', 'Handmade', 'handmade');
INSERT INTO public.tenant_settings (tenant_id) VALUES ('b0000000-0000-4000-8000-000000000001');
INSERT INTO public.notification_type_controls (tenant_id, type, enabled)
SELECT 'b0000000-0000-4000-8000-000000000001', type, true
  FROM public.notification_type_controls WHERE tenant_id = '73cc592f-84ec-457a-b0f7-25a082d7e011';
