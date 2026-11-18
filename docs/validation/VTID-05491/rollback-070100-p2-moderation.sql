-- VTID-05491 rollback of 20261102070100_vtid_05491_mt_tenant_admin_p2_moderation.sql.
-- Drops the stamping trigger, the helpers, the indexes and the tenant_id columns. The tenant values were derived from
-- user_tenants / profile_posts and can be re-derived by re-applying the forward file; the pre-change rows stay in
-- legacy_archive.bak_05491_content_reports / bak_05491_moderation_actions (never dropped here).
-- Refuses while P3 (070150) or the scope policies (070600) are still in place. Owner approval required (collaboration section 7d).
-- Safe to re-run.
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $guard$
BEGIN
  IF to_regprocedure('public.moderator_tenant_scope_enabled(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05491: roll back 20261102070600 first (moderator_tenant_scope_enabled() still exists)';
  END IF;
  IF to_regprocedure('public.moderation_list_reports(uuid,text,integer)') IS NOT NULL
     OR to_regprocedure('public.moderation_resolve_report(uuid,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-05491: roll back 20261102070150 first (the P3 RPCs still exist)';
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS trg_content_reports_stamp_tenant ON public.content_reports;
DROP FUNCTION IF EXISTS public.content_reports_stamp_tenant();
DROP FUNCTION IF EXISTS public.is_tenant_moderator(uuid);
DROP FUNCTION IF EXISTS public.moderation_home_tenant(uuid);
DROP INDEX IF EXISTS public.idx_content_reports_tenant_status;
DROP INDEX IF EXISTS public.idx_moderation_actions_tenant_created;
ALTER TABLE public.content_reports DROP CONSTRAINT IF EXISTS content_reports_tenant_fkey;
ALTER TABLE public.moderation_actions DROP CONSTRAINT IF EXISTS moderation_actions_tenant_fkey;
ALTER TABLE public.content_reports DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE public.moderation_actions DROP COLUMN IF EXISTS tenant_id;
COMMIT;
