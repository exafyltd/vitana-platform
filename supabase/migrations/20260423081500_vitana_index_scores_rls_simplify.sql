-- =============================================================================
-- vitana_index_scores — simplify RLS to user-only
-- Date: 2026-04-23
--
-- The c1 migration (20251231000000_vtid_01078) created 4 separate policies
-- (select/insert/update/delete) that check both tenant_id = current_tenant_id()
-- AND user_id = current_user_id(). Supabase JWTs do not carry tenant_id claims
-- by default, so current_tenant_id() returns NULL for browser-direct queries
-- and rows are invisible to their own owner.
--
-- The c3 migration added a user-only policy, but the c1 policies were never
-- dropped. Policies OR-combine, but if the c3 policy failed to apply, the
-- strict c1 tenant-gated check is all that's left.
--
-- This migration:
--   1. Drops the c1 tenant-gated policies (all 4)
--   2. Drops any previous "user_policy" (idempotent re-creation)
--   3. Creates a single FOR ALL user-scoped policy
--
-- Service-role writes (gateway admin client) still bypass RLS as they always
-- have, so nothing server-side changes. This just makes the row visible to
-- its actual owner when read via the anon key + user JWT.
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS vitana_index_scores_select ON public.vitana_index_scores;
DROP POLICY IF EXISTS vitana_index_scores_insert ON public.vitana_index_scores;
DROP POLICY IF EXISTS vitana_index_scores_update ON public.vitana_index_scores;
DROP POLICY IF EXISTS vitana_index_scores_delete ON public.vitana_index_scores;
DROP POLICY IF EXISTS vitana_index_scores_user_policy ON public.vitana_index_scores;

CREATE POLICY vitana_index_scores_user_policy ON public.vitana_index_scores
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMIT;
