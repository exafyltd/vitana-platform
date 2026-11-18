-- VTID-05491 (mt-tenant-admin-r2/tenant-admin-moderation-db) P3: tenant-scoped moderation RPCs and the review guard.
-- EXPAND ONLY: two new functions and one new trigger; no existing function, policy or grant is changed.
--
--   * public.moderation_list_reports(p_tenant_id, p_status, p_limit): the reports of ONE tenant for that tenant's moderator
--     (public.is_tenant_moderator). p_tenant_id NULL = all tenants including NULL-tenant rows, exafy_admin only.
--     p_limit is clamped to 1..200 (default 50). Newest first. Not authorised -> NOT_AUTHORIZED.
--   * public.moderation_resolve_report(p_report_id, p_status, p_action_taken, p_admin_notes): sets status
--     (pending|reviewed|actioned|dismissed), action_taken, admin_notes, reviewed_by = caller, reviewed_at, and writes ONE
--     moderation_actions row stamped with the report's tenant. Idempotent: the same values again change nothing and write no
--     second audit row. Errors: NOT_AUTHORIZED, BAD_STATUS, REPORT_NOT_FOUND. A report with no tenant is exafy_admin only.
--   * BEFORE UPDATE trigger content_reports_review_guard: tenant_id is assign-once (a NULL tenant may be set, a set tenant is
--     kept), and a status change stamps reviewed_at.
--
-- Both RPCs are SECURITY DEFINER with search_path = public, pg_catalog and an explicit caller check; EXECUTE is granted to
-- authenticated and service_role only (not anon). They do not depend on the scope flag: the tenant check is always on, they
-- are new entry points that nothing calls until the gateway lane wires them.
-- Depends on 20261102070100 (tenant_id columns, is_tenant_moderator); refuses without.
--
-- Safe to re-run. lock_timeout 3s with up to 5 retries on lock_not_available.
-- Rollback: docs/validation/VTID-05491/rollback-070150-p3-moderation.sql. Order: docs/multitenancy/MIGRATION-QUEUE.md.

BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'content_reports' AND column_name = 'tenant_id') THEN
    RAISE EXCEPTION 'VTID-05491 P3: content_reports.tenant_id is missing (apply 20261102070100 first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'moderation_actions' AND column_name = 'tenant_id') THEN
    RAISE EXCEPTION 'VTID-05491 P3: moderation_actions.tenant_id is missing (apply 20261102070100 first)';
  END IF;
  IF to_regprocedure('public.is_tenant_moderator(uuid)') IS NULL THEN
    RAISE EXCEPTION 'VTID-05491 P3: public.is_tenant_moderator(uuid) is missing (apply 20261102070100 first)';
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

      CREATE OR REPLACE FUNCTION public.moderation_list_reports(
        p_tenant_id uuid,
        p_status    text DEFAULT NULL,
        p_limit     int  DEFAULT 50
      ) RETURNS SETOF public.content_reports
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = public, pg_catalog
      AS $fn$
      BEGIN
        IF NOT public.is_tenant_moderator(p_tenant_id) THEN
          RAISE EXCEPTION 'NOT_AUTHORIZED';
        END IF;
        RETURN QUERY
          SELECT r.*
            FROM public.content_reports r
           WHERE (p_tenant_id IS NULL OR r.tenant_id = p_tenant_id)
             AND (p_status IS NULL OR r.status = p_status)
           ORDER BY r.created_at DESC, r.id
           LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
      END
      $fn$;

      CREATE OR REPLACE FUNCTION public.moderation_resolve_report(
        p_report_id    uuid,
        p_status       text,
        p_action_taken text DEFAULT NULL,
        p_admin_notes  text DEFAULT NULL
      ) RETURNS public.content_reports
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_catalog
      AS $fn$
      DECLARE
        v_row public.content_reports;
      BEGIN
        IF p_status IS NULL OR p_status NOT IN ('pending', 'reviewed', 'actioned', 'dismissed') THEN
          RAISE EXCEPTION 'BAD_STATUS';
        END IF;
        SELECT * INTO v_row FROM public.content_reports WHERE id = p_report_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'REPORT_NOT_FOUND';
        END IF;
        IF NOT public.is_tenant_moderator(v_row.tenant_id) THEN
          RAISE EXCEPTION 'NOT_AUTHORIZED';
        END IF;
        -- Idempotent: the same outcome again is a no-op and writes no second audit row.
        IF v_row.status = p_status
           AND v_row.action_taken IS NOT DISTINCT FROM p_action_taken
           AND v_row.admin_notes IS NOT DISTINCT FROM p_admin_notes THEN
          RETURN v_row;
        END IF;
        UPDATE public.content_reports
           SET status = p_status,
               action_taken = p_action_taken,
               admin_notes = p_admin_notes,
               reviewed_by = auth.uid(),
               reviewed_at = now(),
               updated_at = now()
         WHERE id = p_report_id
         RETURNING * INTO v_row;
        INSERT INTO public.moderation_actions (actor_id, action, target_type, target_id, reason, tenant_id)
        VALUES (auth.uid(), 'report_' || p_status, 'report', p_report_id, p_admin_notes, v_row.tenant_id);
        RETURN v_row;
      END
      $fn$;

      REVOKE ALL ON FUNCTION public.moderation_list_reports(uuid, text, int) FROM PUBLIC, anon;
      REVOKE ALL ON FUNCTION public.moderation_resolve_report(uuid, text, text, text) FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.moderation_list_reports(uuid, text, int) TO authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.moderation_resolve_report(uuid, text, text, text) TO authenticated, service_role;

      COMMENT ON FUNCTION public.moderation_list_reports(uuid, text, int) IS
        'VTID-05491: reports of one tenant for its moderator; NULL tenant = all, exafy_admin only. Limit clamped 1..200.';
      COMMENT ON FUNCTION public.moderation_resolve_report(uuid, text, text, text) IS
        'VTID-05491: idempotent tenant-checked report resolution with one tenant-stamped audit row. NOT_AUTHORIZED / BAD_STATUS / REPORT_NOT_FOUND.';

      CREATE OR REPLACE FUNCTION public.content_reports_review_guard()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_catalog
      AS $fn$
      BEGIN
        IF OLD.tenant_id IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
          NEW.tenant_id := OLD.tenant_id;
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status AND NEW.reviewed_at IS NOT DISTINCT FROM OLD.reviewed_at THEN
          NEW.reviewed_at := now();
        END IF;
        RETURN NEW;
      END
      $fn$;
      REVOKE ALL ON FUNCTION public.content_reports_review_guard() FROM PUBLIC, anon, authenticated;

      DROP TRIGGER IF EXISTS trg_content_reports_review_guard ON public.content_reports;
      CREATE TRIGGER trg_content_reports_review_guard
        BEFORE UPDATE ON public.content_reports
        FOR EACH ROW EXECUTE FUNCTION public.content_reports_review_guard();

      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try >= 5 THEN RAISE; END IF;
      RAISE NOTICE 'VTID-05491 P3: lock timeout, retry % of 5', v_try;
      PERFORM pg_sleep(v_try);
    END;
  END LOOP;
END
$mig$;

COMMIT;
