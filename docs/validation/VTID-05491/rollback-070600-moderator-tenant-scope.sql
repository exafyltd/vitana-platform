-- VTID-05491 rollback of 20261102070600_vtid_05491_mt_moderator_tenant_scope.sql.
-- Restores the pre-lane policies (vitana-v1 20251010065205:112-118 and 20260622120000_vtid_03319_phase1_moderation.sql:60-63)
-- and drops moderator_tenant_scope_enabled(). No data is touched. Owner approval required (collaboration section 7d); Kiro runs it
-- through RUN-MIGRATION, never from a PR. Roll back in reverse order: 070600 first, then 070150, then 070100. Safe to re-run.
BEGIN;
SET LOCAL lock_timeout = '3s';

DROP POLICY IF EXISTS "Staff and admins can view all reports" ON public.content_reports;
CREATE POLICY "Staff and admins can view all reports" ON public.content_reports FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.role IN ('staff', 'admin') AND m.status = 'active') OR COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false) = true);

DROP POLICY IF EXISTS "Staff and admins can update reports" ON public.content_reports;
CREATE POLICY "Staff and admins can update reports" ON public.content_reports FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = auth.uid() AND m.role IN ('staff', 'admin') AND m.status = 'active') OR COALESCE((auth.jwt() -> 'app_metadata' ->> 'exafy_admin')::boolean, false) = true);

DROP POLICY IF EXISTS "Admins view moderation actions" ON public.moderation_actions;
CREATE POLICY "Admins view moderation actions" ON public.moderation_actions FOR SELECT TO authenticated
USING (public.is_community_moderator());

DROP FUNCTION IF EXISTS public.moderator_tenant_scope_enabled(uuid);
COMMIT;
