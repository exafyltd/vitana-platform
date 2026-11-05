-- VTID-05464 (mt-identity-r2 / access-token-hook-shadow) test fixture.
--
-- For a throwaway local PostgreSQL 16 cluster with the pgTAP extension
-- available (apt postgresql-16-pgtap). Never point it at a shared database.
-- It creates the Supabase roles the migrations grant to, and the live shape of
-- public.user_tenants the hook reads (20251231000000_vtid_01101_phase_a_bootstrap.sql:90-104
-- columns, UNIQUE (tenant_id, user_id), idx_user_tenants_user; the FKs to
-- tenants/app_users are left out because the hook reads neither table).
--
-- Order (docs/validation/VTID-05464/commands.log):
--   this fixture
--   20261102032000_vtid_05464_access_token_hook_shadow.sql            (x2)
--   20261102032000_vtid_05464_access_token_hook_shadow_rollback.sql   (replay: no-op)
--   20261102032100_vtid_05464_tenant_claim_mismatch_log.sql           (x2)
--   supabase/tests/mt_identity_hook_shadow.test.sql                    (pg_prove)
--   rollback (drops both), rollback again (no-op), re-apply both forward files.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
END $$;

-- Supabase grants the API roles schema usage; supabase_auth_admin gets it from the hook migration.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE EXTENSION IF NOT EXISTS pgtap;

CREATE TABLE IF NOT EXISTS public.user_tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  active_role text NOT NULL DEFAULT 'community',
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_tenants_user ON public.user_tenants (user_id);
ALTER TABLE public.user_tenants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.user_tenants TO authenticated, service_role;

-- Tenants: A = …a1, B = …b2, C = …c3. Users:
--   …0011 member of A (primary) and B (not primary)
--   …0022 member of B only, no is_primary row (two rows, B older than C)
--   …0033 no membership
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary, created_at) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000011', true,  '2026-01-01'),
  ('bbbbbbbb-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000011', false, '2026-02-01'),
  ('bbbbbbbb-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000022', false, '2026-01-01'),
  ('cccccccc-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-000000000022', false, '2026-03-01')
ON CONFLICT (tenant_id, user_id) DO NOTHING;
