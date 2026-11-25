-- 00-sparring-roles.sql — the PostgREST request roles for the sparring-only restore on Aurora staging.
-- Derived from PR #5104 docs/validation/VTID-05803/migration/00-supabase-roles-and-auth.sql (sha256 d600eefc…c7b5),
-- with two changes found by the rehearsal (rehearsal.md, run 1):
--   * service_role is created WITHOUT BYPASSRLS. Aurora's master user is NOSUPERUSER/NOBYPASSRLS
--     ("Understanding the rds_superuser role", AWS docs), and PostgreSQL 16+ allows only a role that has BYPASSRLS to
--     create one: the original file fails there with "permission denied to create role". It is not needed: every table
--     of this restore has an explicit `FOR ALL TO service_role USING (true)` policy.
--   * the auth / storage / extensions schemas and the auth.* helper functions are left out: no file of this restore
--     references them.
DO $$ BEGIN CREATE ROLE anon NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
