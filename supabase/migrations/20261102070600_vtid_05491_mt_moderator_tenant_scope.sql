-- VTID-05491 (mt-tenant-admin-r2/tenant-admin-moderation-db) moderator tenant-scope: content_reports and moderation_actions
-- RLS. Sorts after mt-community-isolation-r2's reserved C3 slot 20261102070160 (which this lane does not create).
--
-- Today the policies "Staff and admins can view all reports" / "Staff and admins can update reports" (content_reports) and
-- "Admins view moderation actions" (moderation_actions) let a staff/admin membership in ANY tenant read and update every
-- tenant's rows. This migration replaces them with policies that are INERT while a row's tenant has the flag off and
-- tenant-scoped once it is on:
--
--   exafy_admin claim
--   OR CASE WHEN moderator_tenant_scope_enabled(row.tenant_id)
--           THEN an active staff/admin membership IN row.tenant_id          (NULL tenant: nobody but exafy_admin)
--           ELSE the legacy test: an active staff/admin membership in ANY tenant   (exactly today)
--      END
--
-- Flag: tenant_settings.feature_flags -> 'mt' ->> 'moderator_tenant_scope' = 'true', per tenant. For a row with no tenant the
-- helper is true iff ANY tenant has the flag on, so NULL-tenant rows stop being visible to tenant moderators as soon as the
-- first tenant is enabled (global coupling by design, fail closed; the rows stay visible to exafy_admin). Flag off everywhere
-- = the pre-migration result for every user. No bare current_tenant_id(): the membership test uses auth.uid().
-- INSERT policy of content_reports and the service_role paths are untouched. user_suspensions has no tenant column and is out of
-- scope here (follow-up with mt-community-isolation).
--
-- Depends on 20261102070100 (tenant_id columns). Safe to re-run. lock_timeout 3s with up to 5 retries.
-- Rollback: docs/validation/VTID-05491/rollback-070600-moderator-tenant-scope.sql. Order: docs/multitenancy/MIGRATION-QUEUE.md.

BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'content_reports' AND column_name = 'tenant_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'moderation_actions' AND column_name = 'tenant_id') THEN
    RAISE EXCEPTION 'VTID-05491 scope: tenant_id columns are missing (apply 20261102070100 first)';
  END IF;
  IF to_regclass('public.tenant_settings') IS NULL THEN
    RAISE EXCEPTION 'VTID-05491 scope: public.tenant_settings is missing';
  END IF;
  IF to_regprocedure('public.is_tenant_moderator(uuid)') IS NULL THEN
    RAISE EXCEPTION 'VTID-05491 scope: public.is_tenant_moderator(uuid) is missing (apply 20261102070100 first)';
  END IF;
END
$guard$;

DO $mig$
DECLARE
  v_try int := 0;
BEGIN
  LOOP
    v_try := v_try + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';

      CREATE OR REPLACE FUNCTION public.moderator_tenant_scope_enabled(p_tenant_id uuid)
      RETURNS boolean
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = public, pg_catalog
      AS $fn$
      DECLARE
        v_on boolean;
      BEGIN
        IF p_tenant_id IS NULL THEN
          RETURN EXISTS (SELECT 1 FROM public.tenant_settings ts
                          WHERE ts.feature_flags -> 'mt' ->> 'moderator_tenant_scope' = 'true');
        END IF;
        SELECT ts.feature_flags -> 'mt' ->> 'moderator_tenant_scope' = 'true' INTO v_on
          FROM public.tenant_settings ts
         WHERE ts.tenant_id = p_tenant_id;
        RETURN coalesce(v_on, false);
      END
      $fn$;
      REVOKE ALL ON FUNCTION public.moderator_tenant_scope_enabled(uuid) FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.moderator_tenant_scope_enabled(uuid) TO authenticated, service_role;
      COMMENT ON FUNCTION public.moderator_tenant_scope_enabled(uuid) IS
        'VTID-05491: per-tenant mt.moderator_tenant_scope flag; for a NULL tenant true iff any tenant has it on. false when off / no row.';

      -- content_reports: same names as today, so the rollback restores them one for one.
      DROP POLICY IF EXISTS "Staff and admins can view all reports" ON public.content_reports;
      CREATE POLICY "Staff and admins can view all reports" ON public.content_reports FOR SELECT TO authenticated
      USING (
        COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false) = true
        OR CASE WHEN public.moderator_tenant_scope_enabled(tenant_id)
             THEN tenant_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM public.memberships m
                               WHERE m.user_id = (SELECT auth.uid()) AND m.tenant_id = content_reports.tenant_id
                                 AND m.role::text IN ('staff', 'admin') AND m.status = 'active')
             ELSE EXISTS (SELECT 1 FROM public.memberships m
                           WHERE m.user_id = (SELECT auth.uid()) AND m.role::text IN ('staff', 'admin') AND m.status = 'active')
           END
      );

      DROP POLICY IF EXISTS "Staff and admins can update reports" ON public.content_reports;
      CREATE POLICY "Staff and admins can update reports" ON public.content_reports FOR UPDATE TO authenticated
      USING (
        COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false) = true
        OR CASE WHEN public.moderator_tenant_scope_enabled(tenant_id)
             THEN tenant_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM public.memberships m
                               WHERE m.user_id = (SELECT auth.uid()) AND m.tenant_id = content_reports.tenant_id
                                 AND m.role::text IN ('staff', 'admin') AND m.status = 'active')
             ELSE EXISTS (SELECT 1 FROM public.memberships m
                           WHERE m.user_id = (SELECT auth.uid()) AND m.role::text IN ('staff', 'admin') AND m.status = 'active')
           END
      );

      -- moderation_actions: legacy branch is the existing is_community_moderator().
      DROP POLICY IF EXISTS "Admins view moderation actions" ON public.moderation_actions;
      CREATE POLICY "Admins view moderation actions" ON public.moderation_actions FOR SELECT TO authenticated
      USING (
        COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false) = true
        OR CASE WHEN public.moderator_tenant_scope_enabled(tenant_id)
             THEN tenant_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM public.memberships m
                               WHERE m.user_id = (SELECT auth.uid()) AND m.tenant_id = moderation_actions.tenant_id
                                 AND m.role::text IN ('staff', 'admin') AND m.status = 'active')
             ELSE public.is_community_moderator()
           END
      );

      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try >= 5 THEN RAISE; END IF;
      RAISE NOTICE 'VTID-05491 scope: lock timeout, retry % of 5', v_try;
      PERFORM pg_sleep(v_try);
    END;
  END LOOP;
END
$mig$;

COMMIT;
