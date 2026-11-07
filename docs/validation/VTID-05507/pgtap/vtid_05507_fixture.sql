-- VTID-05507 fixture: tenants that exist BEFORE the lane migrations run. Local throwaway database only
-- (PGlite / `supabase test db`); never a shared or live one. Load after the base schema and 20261014000600 (VTID-05151).
-- Ids: maxina ...a0, alkalma ...a1, T_A ...a2 (active), T_I ...a3 (INACTIVE), T_P ...a4 (PLATFORM).
INSERT INTO public.tenants (tenant_id, slug, name, is_active, is_platform) VALUES
  ('05507000-0000-4000-8000-0000000000a0', 'maxina',   'Maxina',          true,  false),
  ('05507000-0000-4000-8000-0000000000a1', 'alkalma',  'Alkalma',         true,  false),
  ('05507000-0000-4000-8000-0000000000a2', 't05507a',  'Tenant A',        true,  false),
  ('05507000-0000-4000-8000-0000000000a3', 't05507i',  'Tenant Inactive', false, false),
  ('05507000-0000-4000-8000-0000000000a4', 't05507p',  'Tenant Platform', true,  true);
INSERT INTO public.reserved_tenant_slugs (slug, source) VALUES ('admin', 'platform'), ('api', 'platform'), ('app', 'platform');
