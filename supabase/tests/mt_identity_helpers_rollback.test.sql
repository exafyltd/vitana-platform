-- mt-identity-r2 / helpers-and-policy-rewrite (VTID-05465) — pgTAP: the rollback restores main.
-- Runs on a throwaway Postgres after supabase/tests/mt_identity_helpers_fixture.sql, both forward
-- migrations and 20261102030100_vtid_05465_bare_policy_rewrite_rollback.sql. Never against a
-- shared or live database. Rolled back at the end.
BEGIN;
SELECT no_plan();

CREATE TEMP TABLE t05465_rewrite_set (tbl text, pol text, cmd text);
INSERT INTO t05465_rewrite_set VALUES
  ('community_groups', 'community_groups_insert', 'INSERT'),
  ('community_groups', 'community_groups_update', 'UPDATE'),
  ('community_groups', 'community_groups_delete', 'DELETE'),
  ('community_meetups', 'community_meetups_insert', 'INSERT'),
  ('community_meetups', 'community_meetups_update', 'UPDATE'),
  ('community_meetups', 'community_meetups_delete', 'DELETE'),
  ('community_listings', 'community_listings_select_public', 'SELECT'),
  ('d42_domain_weights', 'd42_domain_weights_select', 'SELECT'),
  ('event_attendance', 'event_attendance_select', 'SELECT'),
  ('live_highlights', 'live_highlights_select', 'SELECT'),
  ('live_room_attendance', 'live_room_attendance_select', 'SELECT'),
  ('live_rooms', 'live_rooms_select', 'SELECT'),
  ('live_rooms', 'live_rooms_insert', 'INSERT'),
  ('live_rooms', 'live_rooms_update', 'UPDATE'),
  ('products_catalog', 'products_catalog_select', 'SELECT'),
  ('products_catalog', 'products_catalog_insert', 'INSERT'),
  ('services_catalog', 'services_catalog_select', 'SELECT'),
  ('services_catalog', 'services_catalog_insert', 'INSERT'),
  ('tenant_catalog_overrides', 'tenant_catalog_overrides_select', 'SELECT'),
  ('match_targets', 'match_targets_select_policy', 'SELECT'),
  ('match_targets', 'match_targets_insert_policy', 'INSERT'),
  ('match_targets', 'match_targets_update_policy', 'UPDATE'),
  ('relationship_nodes', 'relationship_nodes_select', 'SELECT'),
  ('relationship_nodes', 'relationship_nodes_insert', 'INSERT'),
  ('relationship_nodes', 'relationship_nodes_update', 'UPDATE'),
  ('relationship_nodes', 'relationship_nodes_delete', 'DELETE'),
  ('social_alignment_signals', 'social_alignment_signals_select', 'SELECT'),
  ('social_alignment_signals', 'social_alignment_signals_insert', 'INSERT'),
  ('topic_registry', 'topic_registry_select', 'SELECT'),
  ('topic_registry', 'topic_registry_insert', 'INSERT'),
  ('topic_registry', 'topic_registry_update', 'UPDATE'),
  ('topic_registry', 'topic_registry_delete', 'DELETE');

SELECT is((SELECT count(*)::int FROM t05465_rewrite_set), 32, 'the rewrite set has 32 policies');
SELECT is((SELECT count(DISTINCT tbl)::int FROM t05465_rewrite_set), 15, 'on 15 tables');

-- Every policy is back, with its command, role and original current_tenant_id() filter.
SELECT is((SELECT count(*)::int
           FROM t05465_rewrite_set s
           JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = s.tbl AND p.policyname = s.pol
           WHERE p.cmd = s.cmd
             AND p.roles = ARRAY['authenticated']::name[]
             AND coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') ~ 'current_tenant_id\('
             AND coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') !~ '(is_member|tenant_id_for_policies)\('),
  32, 'all 32 policies are restored in their original form');

-- The two extra predicates are back as they were.
SELECT ok((SELECT qual ~ 'status' AND qual ~ 'current_tenant_id\(' FROM pg_policies
           WHERE tablename = 'community_listings' AND policyname = 'community_listings_select_public'),
  'community_listings_select_public: status filter and current_tenant_id() restored');
SELECT ok((SELECT qual ~ '00000000-0000-0000-0000-000000000001' AND qual ~ 'current_tenant_id\(' FROM pg_policies
           WHERE tablename = 'd42_domain_weights' AND policyname = 'd42_domain_weights_select'),
  'd42_domain_weights_select: global-defaults term and current_tenant_id() restored');

-- USING / WITH CHECK shape as on main: the update policies of match_targets, community_groups and
-- community_meetups have USING only; the others have what their CREATE POLICY had.
SELECT is((SELECT count(*)::int FROM pg_policies
           WHERE policyname IN ('match_targets_update_policy', 'community_groups_update', 'community_meetups_update')
             AND with_check IS NULL AND qual IS NOT NULL),
  3, 'USING-only update policies stay USING-only');
SELECT is((SELECT count(*)::int FROM pg_policies
           WHERE policyname IN ('live_rooms_update', 'relationship_nodes_update', 'topic_registry_update')
             AND with_check IS NOT NULL AND qual IS NOT NULL),
  3, 'USING + WITH CHECK update policies keep both');

-- The helpers are gone: nothing references them any more.
SELECT ok(to_regprocedure('public.is_member(uuid)') IS NULL, 'is_member(uuid) dropped');
SELECT ok(to_regprocedure('public.tenant_id_for_policies()') IS NULL, 'tenant_id_for_policies() dropped');

-- Policies the rewrite never touched are unchanged (health tables: 26 policies in the fixture).
SELECT is((SELECT count(*)::int FROM pg_policies
           WHERE tablename IN ('lab_reports', 'biomarker_results', 'wearable_samples', 'health_features_daily',
                               'vitana_index_scores', 'recommendations', 'safety_constraints')),
  26, 'health-table policies untouched');

SELECT * FROM finish();
ROLLBACK;
