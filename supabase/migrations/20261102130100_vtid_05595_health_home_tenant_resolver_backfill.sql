-- VTID-05595 (mt-native-health-r2/health-home-tenant-db) H2: public.health_home_tenant_id(uuid) and the batched backfill.
--
-- health_home_tenant_id(p_user) is the one place that answers "which tenant holds this member's health data":
--   coalesce(app_users.health_home_tenant_id, the member's single primary user_tenants row)
-- It reads no JWT claim, no app_metadata and no session setting, so it returns the same answer in every session,
-- whichever tenant that session carries (an ab_dual member included). A member with no frozen column and either no
-- primary row or two or more primary rows resolves to NULL: the caller must refuse, never guess.
-- STABLE SECURITY DEFINER, search_path pinned; EXECUTE for service_role only (the gateway), so a member cannot probe
-- another member's memberships through it.
--
-- Backfill (expand only), public.backfill_health_home_tenant(batch) run by this file once: freezes app_users.health_home_tenant_id from each member's primary membership, in batches
-- of 1000 under lock_timeout, only where the column is still NULL. Every row it is about to change is first written to
-- legacy_archive.bak_05595_health_home_tenant (previous value, keep_until = snapshot + 30 days; drop it in a follow-up
-- migration after that date once the owner confirms no rollback is needed).
--
-- GUARD (round-1 F6, self-enforces mt-identity-r2 ordering): the file opens with a RAISE EXCEPTION that aborts unless
-- every member (a user with at least one user_tenants row) has exactly one primary row. Until mt-identity-r2's
-- membership unification (rows 14-16) has run, that is not guaranteed, and a wrong home tenant would be frozen for
-- good. An aborted run changes nothing. Members with 0 or 2+ primary rows therefore never get a frozen value from
-- this file; the resolver still returns NULL for them, and the pre-check lists them for quarantine.
--
-- Safe to re-run: the guard passes again, the backfill finds no NULL column left and the snapshot is never replaced.
-- Rollback: docs/validation/VTID-05595/rollback-130100-health-home-tenant-resolver-backfill.sql
-- Order: docs/multitenancy/MIGRATION-QUEUE.md (row 44), after row 43 and after rows 14-16 (membership-unification).

BEGIN;

DO $mig$
DECLARE
  v_try      int := 0;
  v_batch    constant int := 1000;
  v_bad      bigint;
  v_total    bigint := 0;
  v_left     bigint;
BEGIN
  IF to_regclass('public.app_users') IS NULL OR to_regclass('public.user_tenants') IS NULL THEN
    RAISE EXCEPTION 'VTID-05595: public.app_users or public.user_tenants is missing; refusing to backfill';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'app_users' AND column_name = 'health_home_tenant_id') THEN
    RAISE EXCEPTION 'VTID-05595: app_users.health_home_tenant_id is missing; apply 20261102130000 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'user_tenants' AND column_name = 'is_primary') THEN
    RAISE EXCEPTION 'VTID-05595: user_tenants.is_primary is missing; refusing to backfill';
  END IF;

  -- GUARD: every member has exactly one primary membership row, or nothing is frozen.
  EXECUTE $q$
    SELECT count(*) FROM (
      SELECT ut.user_id
        FROM public.user_tenants ut
       GROUP BY ut.user_id
      HAVING count(*) FILTER (WHERE ut.is_primary) <> 1
    ) s
  $q$ INTO v_bad;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'VTID-05595: % member(s) do not have exactly one primary user_tenants row; run mt-identity-r2 membership unification (queue rows 14-16) first. Nothing was changed.', v_bad;
  END IF;

  LOOP
    v_try := v_try + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';

      -- Resolver. Reads only app_users and user_tenants.
      CREATE OR REPLACE FUNCTION public.health_home_tenant_id(p_user uuid)
      RETURNS uuid
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $fn$
        SELECT coalesce(
          (SELECT au.health_home_tenant_id FROM public.app_users au WHERE au.user_id = p_user),
          (SELECT min(ut.tenant_id::text)::uuid
             FROM public.user_tenants ut
            WHERE ut.user_id = p_user AND ut.is_primary
           HAVING count(*) = 1)
        )
      $fn$;

      REVOKE ALL ON FUNCTION public.health_home_tenant_id(uuid) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.health_home_tenant_id(uuid) TO service_role;

      COMMENT ON FUNCTION public.health_home_tenant_id(uuid) IS
        'VTID-05595: the member''s frozen health home tenant: app_users.health_home_tenant_id, else the single primary user_tenants row, else NULL. Session-independent; service_role only.';

      -- Snapshot table (30-day retention), outside public so it is not part of the public drift inventory.
      CREATE SCHEMA IF NOT EXISTS legacy_archive;
      CREATE TABLE IF NOT EXISTS legacy_archive.bak_05595_health_home_tenant (
        user_id                       uuid        PRIMARY KEY,
        previous_health_home_tenant_id uuid       NULL,
        new_health_home_tenant_id     uuid        NOT NULL,
        snapshot_at                   timestamptz NOT NULL DEFAULT now(),
        keep_until                    timestamptz NOT NULL DEFAULT now() + interval '30 days'
      );
      ALTER TABLE legacy_archive.bak_05595_health_home_tenant ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON legacy_archive.bak_05595_health_home_tenant FROM PUBLIC, anon, authenticated;

      -- Batched backfill, callable on its own (the pgTAP file drives it). It freezes only members that have exactly
      -- one primary row and whose column is still NULL; members with 0 or 2+ primary rows stay NULL. Snapshot first,
      -- in the same statement. Returns the number of members frozen. service_role only.
      CREATE OR REPLACE FUNCTION public.backfill_health_home_tenant(p_batch int DEFAULT 1000)
      RETURNS bigint
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $bf$
      DECLARE
        v_n     bigint;
        v_total bigint := 0;
      BEGIN
        IF p_batch IS NULL OR p_batch < 1 THEN
          RAISE EXCEPTION 'VTID-05595: batch size must be at least 1';
        END IF;
        LOOP
          WITH batch AS (
            SELECT au.user_id, min(ut.tenant_id::text)::uuid AS tenant_id
              FROM public.app_users au
              JOIN public.user_tenants ut ON ut.user_id = au.user_id AND ut.is_primary
             WHERE au.health_home_tenant_id IS NULL
             GROUP BY au.user_id
            HAVING count(*) = 1
             ORDER BY au.user_id
             LIMIT p_batch
          ), snap AS (
            INSERT INTO legacy_archive.bak_05595_health_home_tenant (user_id, previous_health_home_tenant_id, new_health_home_tenant_id)
            SELECT b.user_id, NULL, b.tenant_id FROM batch b
            ON CONFLICT (user_id) DO NOTHING
          )
          UPDATE public.app_users au
             SET health_home_tenant_id = b.tenant_id
            FROM batch b
           WHERE au.user_id = b.user_id AND au.health_home_tenant_id IS NULL;
          GET DIAGNOSTICS v_n = ROW_COUNT;
          EXIT WHEN v_n = 0;
          v_total := v_total + v_n;
        END LOOP;
        RETURN v_total;
      END
      $bf$;
      REVOKE ALL ON FUNCTION public.backfill_health_home_tenant(int) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.backfill_health_home_tenant(int) TO service_role;

      v_total := public.backfill_health_home_tenant(v_batch);

      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try >= 5 THEN
        RAISE EXCEPTION 'VTID-05595: could not lock public.app_users after % tries; run off-peak', v_try;
      END IF;
      v_total := 0;
      PERFORM pg_sleep(1);
    END;
  END LOOP;

  -- Self-check: every member resolves to a home tenant.
  SELECT count(*) INTO v_left
    FROM (SELECT DISTINCT ut.user_id FROM public.user_tenants ut) m
   WHERE public.health_home_tenant_id(m.user_id) IS NULL;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'VTID-05595 self-check: % member(s) still have no health home tenant', v_left;
  END IF;

  RAISE NOTICE 'VTID-05595: froze health_home_tenant_id for % member(s)', v_total;
END
$mig$;

COMMIT;
