-- VTID-05161 (Health Hub Phase 1 / B1, program VTID-05020) — B Change 1c:
-- user_integrations becomes read-only for browser roles.
--
-- APPLY TARGET: Supabase (production) through RUN-MIGRATION.yml, only after
-- this change's Gate 2; Aurora gets the same end state from the parity scripts
-- (scripts/aws/aurora-restore-rls-parity.sql, aurora-cutover-restore-grants.sql).
-- Owner decision at Gate 1 (open question 3): revoke = yes.
--
-- Why: the VTID-04765-era policy user_integrations_owner_all is FOR ALL, so a
-- signed-in browser session can insert/update/delete its own rows directly
-- (confirmed read-only in production 2026-10-13). No client writes it: vitana-v1
-- has no reference to the table, and every writer is the gateway with the
-- service role (routes/integrations-repository.ts,
-- services/voice-tools/health-log-repository.ts,
-- services/orb-tools/health-depth-tools-repository.ts), which bypasses RLS and
-- is not affected by these revokes.
--
-- End state: members may SELECT their own rows; nobody but service_role may
-- INSERT/UPDATE/DELETE. Idempotent; the last block checks the end state by
-- effect and rolls back if it does not hold.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regclass('public.user_integrations') IS NULL THEN
    RAISE EXCEPTION 'VTID-05161: public.user_integrations does not exist on this database';
  END IF;
END
$pre$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.user_integrations FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS user_integrations_owner_all ON public.user_integrations;
DROP POLICY IF EXISTS user_integrations_owner_select ON public.user_integrations;
CREATE POLICY user_integrations_owner_select ON public.user_integrations
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.user_integrations IS
  'Per-user state of each integration source (manual-entry, apple-health, oura, whoop, mfp, etc.). RLS: owner read-only (VTID-05161); writes only by the gateway with service_role. Superseded by health_sources (Aurora) — see DATABASE_SCHEMA.md.';

-- End state, checked by effect.
DO $check$
DECLARE
  v_role text;
  v_priv text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege(v_role, 'public.user_integrations', v_priv) THEN
        RAISE EXCEPTION 'VTID-05161 self-check: % still has % on public.user_integrations', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'user_integrations' AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'VTID-05161 self-check: a non-SELECT policy remains on public.user_integrations';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.user_integrations'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'VTID-05161 self-check: row level security is off on public.user_integrations';
  END IF;
END
$check$;

COMMIT;
