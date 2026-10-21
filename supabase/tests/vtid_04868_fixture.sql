-- VTID-04868 test fixture: the vtid_ledger shape the allocator writes, built
-- the way the tracked migrations build it (20251217000000 table + RLS policy,
-- 20260712110000 anon/authenticated revoke, global_vtid_seq). The test runner
-- then applies the CURRENT allocator migration
-- (20260628120000_fix_allocate_global_vtid_seq_drift.sql) so the VTID-04868
-- migration is exercised against the real prior 3-arg function.
-- Used by scripts/ci/test-vtid-04868-plan-sparring.sh against a throwaway
-- local Postgres. Never run against a live database.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Supabase's default privileges: new tables and functions in public are
-- granted to anon/authenticated/service_role. Reproduced so the migration's
-- REVOKEs are actually tested.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.vtid_ledger (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  vtid TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled',
  tenant TEXT NOT NULL DEFAULT 'vitana',
  layer TEXT,
  module TEXT,
  task_family TEXT,
  task_type TEXT,
  summary TEXT DEFAULT '',
  description TEXT DEFAULT '',
  is_test BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}',
  assigned_to TEXT,
  parent_vtid TEXT,
  spec_status TEXT NOT NULL DEFAULT 'missing',
  is_terminal BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT vtid_ledger_vtid_unique UNIQUE (vtid)
);

ALTER TABLE public.vtid_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY vtid_ledger_service_role_all ON public.vtid_ledger FOR ALL TO service_role USING (true);
REVOKE ALL ON public.vtid_ledger FROM anon;
REVOKE ALL ON public.vtid_ledger FROM authenticated;
GRANT ALL ON public.vtid_ledger TO service_role;

CREATE SEQUENCE public.global_vtid_seq START WITH 1000 INCREMENT BY 1;

-- Existing ledger rows (production has thousands; none carries sparring_id).
INSERT INTO public.vtid_ledger (vtid, title, status, metadata) VALUES
  ('VTID-04800', 'existing 1', 'completed', '{"source":"claude-code"}'),
  ('VTID-04801', 'existing 2', 'in_progress', '{"source":"self-healing","autonomous_execution":true}'),
  ('VTID-04802', 'existing 3', 'scheduled', NULL);
