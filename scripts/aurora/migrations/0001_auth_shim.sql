-- Aurora-only DDL — NOT a Supabase migration, do not put this under
-- supabase/migrations/ and do not run it against the Supabase project.
-- VTID-03591 (Supabase -> Aurora application-layer cutover), phase B4.
--
-- Purpose: let all 925 existing RLS policies run UNCHANGED against Aurora.
-- Supabase's auth.uid()/auth.jwt()/auth.role()/auth.email() are not magic —
-- they are plain SQL functions that read Postgres session GUCs set per
-- request by PostgREST from the validated JWT. Confirmed byte-for-byte via
-- `pg_get_functiondef()` against production (inmkhvwdcuyhnxkgfvsb) on
-- 2026-08-11 — the four definitions below are copied verbatim from that
-- output, not reconstructed from memory or docs.
--
-- The gateway is the new PostgREST-equivalent: it already verifies the JWT
-- and extracts claims (verifyAndExtractIdentity() in
-- services/gateway/src/middleware/auth-supabase-jwt.ts) for its own checks.
-- It now ALSO issues `SET LOCAL request.jwt.claims = '<raw claims json>'`
-- (and `SET LOCAL role`) on every Aurora connection before running a query
-- on a user's behalf — see services/gateway/src/services/aurora-client.ts.
-- With that GUC set, these functions resolve exactly as they do under
-- PostgREST, and no policy needs to be rewritten.
--
-- Not applied by any CI pipeline yet. Run manually against Aurora only
-- after Phase 0 (DMS reconciliation) is closed and the gateway's Aurora
-- client is wired to actually set the GUC — creating the schema early is
-- harmless (it has no effect until something SETs the GUC and something
-- else references auth.uid() against Aurora), but don't let its presence
-- be read as "Aurora is live" — it is one piece of B4, not the cutover.

CREATE SCHEMA IF NOT EXISTS auth;

-- select coalesce(
--   nullif(current_setting('request.jwt.claim.sub', true), ''),
--   (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
-- )::uuid
CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

CREATE OR REPLACE FUNCTION auth.jwt()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$function$;

CREATE OR REPLACE FUNCTION auth.role()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$function$;

CREATE OR REPLACE FUNCTION auth.email()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$function$;

-- Deliberately NOT ported here, and needed before B4 can be called done:
--   auth.users table (GoTrue's own table — 199 rows, credential migration
--     is its own step, tracked separately in the Phase 3b B4 breakdown)
--   any RPC that calls auth.uid()/auth.jwt() internally as part of a larger
--     function body rather than from a table policy (inventory these before
--     assuming "925 policies port unchanged" also covers every RPC — it
--     covers policies, RPCs are Phase B3 and need their own check)
