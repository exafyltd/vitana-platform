-- VTID-05465 read-only post-check, after 20261102030000 and 20261102030100. SELECT only; no writes.
-- The rewrite set is the 32 policies of pre-check.sql section 1 (same list, same order).

-- 1. Both helpers exist, STABLE SECURITY DEFINER, executable by authenticated and not by anon.
SELECT p.oid::regprocedure AS fn, p.prosecdef AS security_definer, p.provolatile = 's' AS stable,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
FROM pg_proc p
WHERE p.oid IN (to_regprocedure('public.is_member(uuid)'), to_regprocedure('public.tenant_id_for_policies()'));

-- 2. Expected 0 rows: no rewrite-set policy still references current_tenant_id(). Scoped to the 32 policies of the
--    rewrite set (reviewer note (b)). A bare policy outside this set is not this lane's result, so it is not listed here.
WITH s(tbl, pol, cmd) AS (VALUES
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
  ('topic_registry', 'topic_registry_delete', 'DELETE')
)
SELECT p.tablename, p.policyname, p.cmd, p.roles
FROM s
JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = s.tbl AND p.policyname = s.pol
WHERE coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') ~ 'current_tenant_id\('
ORDER BY 1, 2;

-- 3. The rewrite set as it now reads. The expected count is the number of pre-check.sql section 1 rows with
--    policy_present = true, taken before the apply. A rewrite-set table that is absent on the target is skipped by the
--    migration, so its policies are not in that count. The summary's rewrite_set_live and rewritten_on_helper must both
--    equal that pre-check count, and on_is_member must be 0.
WITH s(tbl, pol, cmd) AS (VALUES
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
  ('topic_registry', 'topic_registry_delete', 'DELETE')
),
rw AS (
  SELECT s.tbl, s.pol, p.qual, p.with_check
  FROM s
  JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = s.tbl AND p.policyname = s.pol
)
SELECT count(*) AS rewrite_set_live,
       count(*) FILTER (WHERE coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'tenant_id_for_policies\(') AS rewritten_on_helper,
       count(*) FILTER (WHERE coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'is_member\(') AS on_is_member
FROM rw;

-- 3b. The same rewrite-set policies, one row each, as they now read.
WITH s(tbl, pol, cmd) AS (VALUES
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
  ('topic_registry', 'topic_registry_delete', 'DELETE')
)
SELECT p.tablename, p.policyname, p.cmd, p.qual, p.with_check
FROM s
JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = s.tbl AND p.policyname = s.pol
ORDER BY 1, 2;

-- 4. current_tenant_id() unchanged (compare with the pre-apply md5 in pre-check.sql section 3).
SELECT md5(prosrc) AS current_tenant_id_md5 FROM pg_proc WHERE oid = 'public.current_tenant_id()'::regprocedure;
