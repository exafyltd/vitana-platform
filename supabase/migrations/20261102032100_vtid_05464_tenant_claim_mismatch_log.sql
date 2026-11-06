-- VTID-05464 (mt-identity-r2 / access-token-hook-shadow) S2: the soak log of
-- the shadow access-token hook (20261102032000).
--
-- One row per (user, decision, preferred tenant, shadow tenant); a repeat
-- bumps seen_count / last_seen_at instead of adding a row, so token refreshes
-- cannot grow the table without bound. Decisions:
--  * preference_not_member  app_metadata.active_tenant_id names a tenant the
--                           user has no user_tenants row for. current_tenant_id()
--                           trusts that claim today; the shadow does not.
--  * no_membership          the user has no user_tenants row at all; the shadow
--                           is empty and the token is left unchanged.
--  * primary_missing        no preference and no is_primary row; the shadow
--                           falls back to the oldest membership (the
--                           resolvePrimaryTenant() membership_fallback case).
--
-- Service-role-only: REVOKE ALL from PUBLIC, anon and authenticated, GRANT ALL
-- to service_role, RLS enabled with no policy (so even a later accidental
-- client grant reads nothing). The hook writes it as SECURITY DEFINER (owner).
-- No member content: ids, a decision and counters only.
--
-- Expand-only and idempotent (IF NOT EXISTS, repeatable REVOKE/GRANT). Ends
-- with a self-check that RAISEs (and so rolls the whole file back) if the end
-- state is not reached. Rollback:
-- 20261102032000_vtid_05464_access_token_hook_shadow_rollback.sql.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.tenant_claim_mismatch_log (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id               uuid        NOT NULL,
  decision              text        NOT NULL,
  claimed_tenant_id     uuid,
  shadow_tenant_id      uuid,
  authentication_method text,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  seen_count            integer     NOT NULL DEFAULT 1,
  CONSTRAINT tenant_claim_mismatch_log_decision_check
    CHECK (decision IN ('preference_not_member', 'no_membership', 'primary_missing')),
  CONSTRAINT tenant_claim_mismatch_log_key
    UNIQUE NULLS NOT DISTINCT (user_id, decision, claimed_tenant_id, shadow_tenant_id)
);

COMMENT ON TABLE public.tenant_claim_mismatch_log IS
  'VTID-05464: shadow access-token hook soak log (7 days). Service-role only, RLS on, no policy. '
  'One row per user/decision/claimed/shadow tenant; seen_count counts repeats.';

ALTER TABLE public.tenant_claim_mismatch_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tenant_claim_mismatch_log FROM PUBLIC;
REVOKE ALL ON TABLE public.tenant_claim_mismatch_log FROM anon, authenticated;
GRANT ALL ON TABLE public.tenant_claim_mismatch_log TO service_role;

DO $seq$
DECLARE
  s text := pg_get_serial_sequence('public.tenant_claim_mismatch_log', 'id');
BEGIN
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', s);
  EXECUTE format('GRANT ALL ON SEQUENCE %s TO service_role', s);
END
$seq$;

DO $check$
DECLARE
  r text;
  p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(r, 'public.tenant_claim_mismatch_log', p) THEN
        RAISE EXCEPTION 'VTID-05464 self-check: % has % on tenant_claim_mismatch_log', r, p;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.tenant_claim_mismatch_log', p) THEN
      RAISE EXCEPTION 'VTID-05464 self-check: service_role lacks % on tenant_claim_mismatch_log', p;
    END IF;
  END LOOP;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenant_claim_mismatch_log'::regclass) THEN
    RAISE EXCEPTION 'VTID-05464 self-check: RLS is off on tenant_claim_mismatch_log';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant_claim_mismatch_log') THEN
    RAISE EXCEPTION 'VTID-05464 self-check: tenant_claim_mismatch_log must carry no policy';
  END IF;
END
$check$;

COMMIT;
