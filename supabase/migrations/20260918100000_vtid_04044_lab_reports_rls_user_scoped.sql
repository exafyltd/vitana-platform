-- =============================================================================
-- VTID-04044 — lab_reports: make the health-report upload actually land.
-- Date: 2026-09-18
--
-- SYMPTOM. "Upload Health Report" (exafyltd/vitana-v1
-- HealthReportUploadSheet.tsx) has never worked end to end in production.
-- Measured 2026-09-18 against the live project: 22 objects in the
-- `health-reports` storage bucket (4 real users, 2026-03 .. 2026-09-17),
-- 0 rows ever in public.lab_reports, 0 in biomarker_results. Postgres logs
-- for the two most recent uploads (2026-09-17 14:45:37 / 14:45:47 UTC):
--   new row violates row-level security policy for table "lab_reports"
-- Every user got "Upload failed" after the file had already been stored,
-- retried seconds later (the bucket shows the retry bursts), and left
-- orphaned files behind.
--
-- ROOT CAUSE. The c1 policies (20251231000000_vtid_01078) gate every
-- verb on `tenant_id = current_tenant_id() AND user_id = current_user_id()`.
-- The LIVE current_tenant_id() only reads a top-level `tenant_id` / `tenant`
-- JWT claim, which Supabase tokens do not carry — the tenant lives at
-- `app_metadata.active_tenant_id`, which is exactly what the sheet sends.
-- The repo's 20260218000000_fix_maxina_signup_tenant_association.sql adds
-- that fallback to the function, but it was never applied to the live
-- project (function body confirmed, version absent from schema_migrations),
-- so current_tenant_id() returns NULL for every browser-direct request and
-- the WITH CHECK is never satisfied. The SELECT policy has the same shape,
-- so even a row that did land would be invisible to its owner.
--
-- FIX. Same remedy 20260423081500_vitana_index_scores_rls_simplify.sql
-- applied to the sibling table for the same reason: replace the four
-- tenant-gated c1 policies with one user-scoped FOR ALL policy. The row
-- still carries tenant_id (the sheet writes it from app_metadata), and
-- user_id = auth.uid() is strictly narrower than the tenant check it
-- replaces. Deliberately NOT fixing current_tenant_id() here: that function
-- backs RLS on many other tables, and widening it from NULL to the real
-- tenant changes what browser JWTs can read tenant-wide across all of them
-- at once — a separate, reviewed decision, not a side effect of this one.
-- Service-role writes (gateway admin client, partner ingestion) bypass RLS
-- as before.
--
-- ALSO. trg_notify_lab_report fired AFTER INSERT and sent "Lab Report
-- Ready — your lab report has been processed and results are available".
-- Nothing processes an upload yet (AP-0607's `health.lab_report.uploaded`
-- event is never dispatched and there is no parser), so once inserts start
-- succeeding that notification would be false on every upload. It now fires
-- only when processing_status actually transitions to 'parsed', which is
-- what its own name says. The function body is unchanged.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. lab_reports RLS: user-scoped, same as vitana_index_scores
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS lab_reports_select ON public.lab_reports;
DROP POLICY IF EXISTS lab_reports_insert ON public.lab_reports;
DROP POLICY IF EXISTS lab_reports_update ON public.lab_reports;
DROP POLICY IF EXISTS lab_reports_delete ON public.lab_reports;
DROP POLICY IF EXISTS lab_reports_user_policy ON public.lab_reports;

CREATE POLICY lab_reports_user_policy ON public.lab_reports
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON POLICY lab_reports_user_policy ON public.lab_reports IS
  'VTID-04044: user-scoped (auth.uid()). The c1 tenant-gated policies relied on current_tenant_id(), which is NULL for browser JWTs, so no upload ever inserted a row.';

-- ---------------------------------------------------------------------------
-- 2. "processed" notification fires on processing, not on upload
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_notify_lab_report ON public.lab_reports;

CREATE TRIGGER trg_notify_lab_report
  AFTER UPDATE OF processing_status ON public.lab_reports
  FOR EACH ROW
  WHEN (NEW.processing_status = 'parsed' AND OLD.processing_status IS DISTINCT FROM 'parsed')
  EXECUTE FUNCTION public.notify_on_lab_report_processed();

COMMENT ON TRIGGER trg_notify_lab_report ON public.lab_reports IS
  'VTID-04044: was AFTER INSERT (announced "results available" on upload, before anything processes the file). Now fires once, when processing_status becomes parsed.';

COMMIT;
