-- VTID-05491 rollback of 20261102070150_vtid_05491_mt_tenant_admin_p3_moderation.sql.
-- Drops the review-guard trigger and the two tenant-scoped RPCs. Report and audit rows written through them are real rows and are kept.
-- Refuses while the scope policies (070600) are still in place. Owner approval required (collaboration section 7d). Safe to re-run.
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $guard$
BEGIN
  IF to_regprocedure('public.moderator_tenant_scope_enabled(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05491: roll back 20261102070600 first (moderator_tenant_scope_enabled() still exists)';
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS trg_content_reports_review_guard ON public.content_reports;
DROP FUNCTION IF EXISTS public.content_reports_review_guard();
DROP FUNCTION IF EXISTS public.moderation_resolve_report(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.moderation_list_reports(uuid, text, int);
COMMIT;
