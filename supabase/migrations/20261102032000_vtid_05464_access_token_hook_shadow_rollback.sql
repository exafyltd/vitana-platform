-- VTID-05464 (mt-identity-r2 / access-token-hook-shadow) S3: rollback of
-- 20261102032000_vtid_05464_access_token_hook_shadow.sql and
-- 20261102032100_vtid_05464_tenant_claim_mismatch_log.sql. Pre-approved with the
-- lane; applied only by an owner-approved RUN-MIGRATION.yml run (collaboration
-- §7d), never from the PR.
--
-- Precondition: the hook is NOT configured in Supabase Auth (it never is in this
-- lane; GO-LIVE is the owner-applied D14 lane). If a later lane has enabled it,
-- disable the hook in Auth first, or every sign-in fails on a missing function.
--
-- What it drops: the hook function and the soak log. The log holds ids,
-- decisions and counters only (no member content); export it first if the soak
-- evidence is still needed. Nothing else existed before these two files, so
-- this restores the pre-VTID-05464 state exactly.
--
-- Replay guard. This file shares the version 20261102032000 and sorts between
-- the two forward files, so an in-order replay of supabase/migrations/ (the
-- local stack) would run it right after the hook is created. It therefore acts
-- only when the log table of 20261102032100 exists, i.e. when both forward
-- files are applied; otherwise it does nothing and says so. To roll back a
-- database where only 20261102032000 was applied, drop the hook function on
-- its own. The exact statement is in docs/validation/VTID-05464/acceptance.md,
-- "Rollback".
--
-- Idempotent: a second run finds nothing to drop.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $rollback$
BEGIN
  IF to_regclass('public.tenant_claim_mismatch_log') IS NULL THEN
    RAISE NOTICE 'VTID-05464 rollback: tenant_claim_mismatch_log is absent (in-order replay or already rolled back); nothing done';
    RETURN;
  END IF;
  DROP FUNCTION IF EXISTS public.custom_access_token_hook_shadow(jsonb);
  DROP TABLE IF EXISTS public.tenant_claim_mismatch_log;

  IF to_regprocedure('public.custom_access_token_hook_shadow(jsonb)') IS NOT NULL
     OR to_regclass('public.tenant_claim_mismatch_log') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05464 rollback self-check: hook or log still present';
  END IF;
END
$rollback$;

COMMIT;
