-- Aurora-only DDL — see 0001_auth_shim.sql header for context (VTID-03591,
-- Phase B4). Run this FIRST, before 0001 — the shim functions don't
-- reference these roles directly, but the RLS policies DMS already
-- replicated onto Aurora do (`TO authenticated`, `TO service_role`, etc.),
-- and those grants are meaningless until the roles exist.
--
-- Confirmed against production 2026-08-11: every public-schema RLS policy's
-- `roles` column is one of {public}, {authenticated}, {service_role}, or
-- {anon,authenticated} — no other role name appears. These four are the
-- complete set Aurora needs, not a guess.
--
--   roles                | policy count
--   ----------------------+-------------
--   {public}              | 528
--   {authenticated}       | 346
--   {service_role}        | 135
--   {anon,authenticated}  | 6
--
-- NOLOGIN because nothing connects AS these roles directly — the gateway's
-- single pooled DB user connects as itself and does `SET LOCAL ROLE` per
-- request (see aurora-client.ts), the same relationship PostgREST has to
-- Supabase's authenticator/anon/authenticated roles. That means the
-- gateway's pooled login role must be GRANTed membership in all three
-- switchable roles below, or `SET LOCAL ROLE authenticated` will fail with
-- "permission denied to set role" — done at the end of this file.
--
-- $AURORA_APP_DB_USER must be replaced with the actual login role name
-- before running (the `claude_readonly` role from the Phase-0 investigation
-- is NOT this — it's a diagnostic role with no place in the request path;
-- this is whatever role the gateway's pg.Pool actually authenticates as,
-- not yet created as of this draft).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;

-- GRANT anon, authenticated, service_role TO $AURORA_APP_DB_USER;
