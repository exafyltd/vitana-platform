-- VTID-05023 Aurora compatibility layer.
-- AURORA-ONLY: must not run on Supabase.
--
-- Why: Aurora PostgreSQL has no auth schema, no auth.uid()/auth.role()/auth.jwt()
-- and no anon/authenticated/service_role roles. Supabase already provides all of
-- them and owns the auth schema, so this file would overwrite Supabase definitions.
-- scripts/ci/apply-sql-via-management-api.sh skips files marked AURORA-ONLY on
-- Supabase. scripts/aws/aurora-apply-migration.sh applies them on Aurora.
-- Inventory: docs/validation/VTID-05023/compat-objects.md.
--
-- Scope: roles, schema auth, auth.jwt(), auth.uid(), auth.role().
-- Not covered: auth.users, auth.sessions, auth.oauth_clients, auth.oauth_authorizations
-- (migrations need real tables with FK targets; auth_user_fk_map holds FK rules, not users)
-- and storage.* (Storage stays on Supabase).
--
-- Every statement is idempotent. The session claims come from the PostgREST
-- convention: request.jwt.claims holds the JWT payload as JSON.

CREATE SCHEMA IF NOT EXISTS auth;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- NULL when no claims are set (or the setting is empty), so RLS policies that
-- compare against auth.uid() match no rows for an anonymous session.
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT auth.jwt() ->> 'role'
$$;
