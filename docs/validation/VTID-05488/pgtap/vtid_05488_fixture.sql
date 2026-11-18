-- VTID-05488 fixture: rows that exist BEFORE the lane migrations run (so the Maxina-only seed and the partner_tenant
-- backfill have something to act on). Load after the base schema and before 20261102120000..120300.
-- Local throwaway database only (PGlite / `supabase test db`); never a shared or live one.
INSERT INTO public.tenants (slug, name) VALUES ('maxina', 'Maxina'), ('t05488a', 'Tenant A'), ('t05488b', 'Tenant B');
UPDATE public.tenants SET is_default = true WHERE slug = 'maxina';
-- Fixed ids: Maxina ...a0, T_A ...a1, T_B ...b1.
UPDATE public.tenants SET tenant_id = '05488000-0000-4000-8000-0000000000a0' WHERE slug = 'maxina';
UPDATE public.tenants SET tenant_id = '05488000-0000-4000-8000-0000000000a1' WHERE slug = 't05488a';
UPDATE public.tenants SET tenant_id = '05488000-0000-4000-8000-0000000000b1' WHERE slug = 't05488b';
-- A tenant whose SLUG is T_A's uuid text: the text '…a1' then names two tenants (ambiguous, must stay NULL).
INSERT INTO public.tenants (slug, name) VALUES ('05488000-0000-4000-8000-0000000000a1', 'Ambiguous slug tenant');

-- Users: uMax (Maxina), uA (T_A), uB (T_B), uN (no membership -> current_tenant_id() IS NULL).
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
  ('05488000-0000-4000-8000-0000000000a0', '05488000-0000-4000-8000-0000000000c0', true),
  ('05488000-0000-4000-8000-0000000000a1', '05488000-0000-4000-8000-0000000000c1', true),
  ('05488000-0000-4000-8000-0000000000b1', '05488000-0000-4000-8000-0000000000c2', true);

-- Merchants and products that exist today (all end up 'community', Maxina-active after the migrations).
INSERT INTO public.merchants (id, name, source_network, is_active) VALUES
  ('05488000-0000-4000-8000-0000000000d1', 'Existing merchant one', 'cj', true),
  ('05488000-0000-4000-8000-0000000000d2', 'Existing merchant two (inactive)', 'awin', false);
INSERT INTO public.products (id, merchant_id, source_network, source_product_id, title, affiliate_url, is_active) VALUES
  ('05488000-0000-4000-8000-0000000000e1', '05488000-0000-4000-8000-0000000000d1', 'cj', 'p1', 'P_X1 existing active', 'https://example.test/1', true),
  ('05488000-0000-4000-8000-0000000000e2', '05488000-0000-4000-8000-0000000000d1', 'cj', 'p2', 'P_X2 existing inactive', 'https://example.test/2', false);

-- partner_tenant free text: uuid of Maxina, slug with case/space noise, slug of T_A, unknown key, uuid of nothing, ambiguous.
INSERT INTO public.partner_tenant (id, tenant_id, name) VALUES
  ('pt1', '05488000-0000-4000-8000-0000000000a0', 'uuid of Maxina'),
  ('pt2', ' MAXINA ', 'slug of Maxina, noisy'),
  ('pt3', 'unknown-partner-key', 'unresolvable'),
  ('pt4', '05488000-0000-4000-8000-0000000000ff', 'uuid of no tenant'),
  ('pt5', 't05488a', 'slug of T_A'),
  ('pt6', '05488000-0000-4000-8000-0000000000a1', 'uuid of T_A and slug of another tenant: ambiguous');
