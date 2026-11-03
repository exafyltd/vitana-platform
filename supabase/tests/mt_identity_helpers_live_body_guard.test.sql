-- mt-identity-r2 / helpers-and-policy-rewrite (VTID-05465) — pgTAP: the live-body guard refuses the OLD body.
-- Runs on a throwaway Postgres, never a shared or live one, in this order:
--   1. supabase/tests/mt_identity_helpers_fixture.sql                  (current_tenant_id() = the 20260218 body)
--   2. supabase/tests/mt_identity_helpers_live_body_guard_fixture.sql  (current_tenant_id() = the 20251229 body)
--   3. supabase/migrations/20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql
--   4. supabase/migrations/20261102030100_vtid_05465_bare_policy_rewrite.sql
--        must RAISE "VTID-05465: the live public.current_tenant_id() is not the 20260218 body". The runner then
--        rolls that transaction back. If step 4 commits instead (no guard), the assertions below fail, because the
--        rewrite ran on the old body.
--   5. this file (read only; rolled back at the end).
BEGIN;
SELECT no_plan();

CREATE TEMP TABLE t05465_guard_set (tbl text, pol text, cmd text);
INSERT INTO t05465_guard_set VALUES
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

-- Precondition: the live body is the old one. None of the guard's markers is in it.
SELECT ok(position('v_jwt_claims->''app_metadata''->>''active_tenant_id''' IN pg_get_functiondef('public.current_tenant_id()'::regprocedure)) = 0,
  'precondition: the live current_tenant_id() has no app_metadata fallback (the 20251229 body)');
SELECT ok(position('FROM public.user_tenants' IN pg_get_functiondef('public.current_tenant_id()'::regprocedure)) = 0,
  'precondition: the live current_tenant_id() has no user_tenants fallback (the 20251229 body)');

-- The refused apply left all 32 rewrite-set policies on current_tenant_id() (all 15 tables are in the fixture).
SELECT is(
  (SELECT count(*) FROM t05465_guard_set s
     JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = s.tbl AND p.policyname = s.pol
   WHERE coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') ~ 'current_tenant_id\('),
  32::bigint,
  'refused: all 32 rewrite-set policies still read current_tenant_id()');
SELECT is(
  (SELECT count(*) FROM t05465_guard_set s
     JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = s.tbl AND p.policyname = s.pol
   WHERE coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') ~ 'tenant_id_for_policies\('),
  0::bigint,
  'refused: no rewrite-set policy reads tenant_id_for_policies()');
SELECT ok(to_regprocedure('public.tenant_id_for_policies()') IS NOT NULL,
  'the helpers from 20261102030000 are in place (step 3 ran)');

SELECT * FROM finish();
ROLLBACK;
