-- VTID-05520: synthetic tenants and members for the PGlite local stack. Every id and name is made up.
-- Idempotent: ON CONFLICT DO NOTHING on fixed ids. Users go into the stub auth.users (INSERT), never CREATE TABLE.
-- Ids are mirrored in scripts/mt/stack/fixture-ids.mjs (fixtures.test.mjs checks the two agree).
--   T_A aaaaaaaa-0000-4000-8000-00000000000a   T_B bbbbbbbb-0000-4000-8000-00000000000b
-- Triggers are off for the load (session_replication_role = replica): the welcome-chat and notification fan-out triggers
-- (VTID-03990, VTID-03506) must never act on fixture rows, here or anywhere a fixture is copied to.
BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO public.tenants (id, slug, name) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'mt-fixture-a', 'MT Fixture Tenant A'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'mt-fixture-b', 'MT Fixture Tenant B')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (id, email) VALUES
  ('0000000a-0000-4000-8000-000000000001', 'a_member@mt-fixture.invalid'),
  ('0000000a-0000-4000-8000-000000000002', 'a_admin@mt-fixture.invalid'),
  ('0000000b-0000-4000-8000-000000000001', 'b_member@mt-fixture.invalid'),
  ('0000000b-0000-4000-8000-000000000002', 'b_admin@mt-fixture.invalid'),
  ('0000000c-0000-4000-8000-000000000001', 'ab_dual@mt-fixture.invalid')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary)
SELECT v.tenant_id::uuid, v.user_id::uuid, v.active_role, v.is_primary
FROM (VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000a-0000-4000-8000-000000000001', 'community', true),
  ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000a-0000-4000-8000-000000000002', 'admin',     true),
  ('bbbbbbbb-0000-4000-8000-00000000000b', '0000000b-0000-4000-8000-000000000001', 'community', true),
  ('bbbbbbbb-0000-4000-8000-00000000000b', '0000000b-0000-4000-8000-000000000002', 'admin',     true),
  ('aaaaaaaa-0000-4000-8000-00000000000a', '0000000c-0000-4000-8000-000000000001', 'community', true),
  ('bbbbbbbb-0000-4000-8000-00000000000b', '0000000c-0000-4000-8000-000000000001', 'community', false)
) AS v(tenant_id, user_id, active_role, is_primary)
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_tenants ut WHERE ut.tenant_id = v.tenant_id::uuid AND ut.user_id = v.user_id::uuid
);

COMMIT;
