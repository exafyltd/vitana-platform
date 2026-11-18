-- VTID-05803 restore prerequisite (staging only). Applied BEFORE pg_restore pre-data.
-- 1. Supabase-managed roles and schemas that the dump's GRANT and POLICY statements reference.
-- 2. The four auth helpers with the exact production bodies (pg_get_functiondef on production, 2026-11-17, read-only).
--    The earlier stub in bootstrap-evidence/00-supabase-compat.sql returned NULL for auth.uid() when only the JSON
--    claims form is set, which would make every RLS policy that uses auth.uid() deny all rows. It is NOT used here.
-- NOT created here: auth.users. The 136 foreign keys into auth/storage need a decision (see the VTID-05803 report);
-- the restore fails closed at post-data until that decision is taken.
DO $$ BEGIN CREATE ROLE anon NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid LANGUAGE sql STABLE AS $function$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$function$;
CREATE OR REPLACE FUNCTION auth.role()
 RETURNS text LANGUAGE sql STABLE AS $function$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$function$;
CREATE OR REPLACE FUNCTION auth.jwt()
 RETURNS jsonb LANGUAGE sql STABLE AS $function$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$function$;
CREATE OR REPLACE FUNCTION auth.email()
 RETURNS text LANGUAGE sql STABLE AS $function$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text
$function$;
GRANT USAGE ON SCHEMA public, auth, storage, extensions TO anon, authenticated, service_role;
