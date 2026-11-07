-- VTID-05465 read-only pre-check, before 20261102030000 / 20261102030100. SELECT only; no writes.
-- Run by the RUN-MIGRATION.yml dispatch the owner approves (collaboration.md §7d), never from a session.

-- 1. The 32 policies of the rewrite set as they are live (absent table -> table_present false).
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
SELECT s.tbl, s.pol, s.cmd,
       to_regclass('public.' || s.tbl) IS NOT NULL AS table_present,
       p.policyname IS NOT NULL AS policy_present,
       p.cmd AS live_cmd, p.roles AS live_roles, p.qual, p.with_check
FROM s
LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = s.tbl AND p.policyname = s.pol
ORDER BY s.tbl, s.pol;

-- 2. Column evidence: which of the 15 tables have a user_id column live
--    (expected: event_attendance, live_room_attendance only). Informational since plan
--    amendment 1: every rewritten policy uses the same tenant term, whatever the columns.
SELECT table_name
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'user_id'
  AND table_name IN ('community_groups', 'community_meetups', 'community_listings', 'd42_domain_weights',
                     'event_attendance', 'live_highlights', 'live_room_attendance', 'live_rooms',
                     'products_catalog', 'services_catalog', 'tenant_catalog_overrides', 'match_targets',
                     'relationship_nodes', 'social_alignment_signals', 'topic_registry')
ORDER BY 1;

-- 3. The helpers do not exist yet; user_tenants has its unique (tenant_id, user_id) index.
SELECT to_regprocedure('public.is_member(uuid)') AS is_member,
       to_regprocedure('public.tenant_id_for_policies()') AS tenant_id_for_policies,
       (SELECT string_agg(indexrelid::regclass::text, ', ') FROM pg_index
        WHERE indrelid = 'public.user_tenants'::regclass AND indisunique) AS user_tenants_unique_indexes,
       (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.current_tenant_id()'::regprocedure) AS current_tenant_id_md5;

-- 4. Bare current_tenant_id() policies live, all tables (the SQL form of scripts/ci/bare-policy-lint.mjs).
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'current_tenant_id\('
  AND coalesce(qual, '') || ' ' || coalesce(with_check, '') !~ '(auth\.uid|current_user_id|is_member|is_tenant_admin|auth\.role)\('
  AND NOT roles <@ ARRAY['service_role', 'postgres', 'supabase_admin']::name[]
ORDER BY 1, 2;

-- 5. The live current_tenant_id() body, read the way the guard in 20261102030100 reads it (DO $pre$). The rewrite runs
--    only if all three markers are true, and the migration prints the same values as NOTICE lines. A false marker means
--    the live body is not the 20260218 body. The docs describe the 20251229 body as the live one. The migration then
--    refuses, and the lane is parked for an owner decision (acceptance.md, premises table). Read only.
WITH f AS (SELECT pg_get_functiondef('public.current_tenant_id()'::regprocedure) AS def)
SELECT left(def, 200) AS live_body_first_200,
       position('v_jwt_claims->''app_metadata''->>''active_tenant_id''' IN def) > 0 AS marker_1_app_metadata_fallback,
       position('FROM public.user_tenants' IN def) > 0 AS marker_2_user_tenants_fallback,
       position('WHERE user_id = auth.uid()' IN def) > 0 AS marker_3_own_membership_lookup
FROM f;

-- 6. Read-only count: members whose resolved tenant changes under the rewrite (reviewer note (a); acceptance.md, premises
--    table, row "The rewrite causes no visible change"). Under the 20260218 body, a browser JWT resolves to
--    app_metadata.active_tenant_id when that is set, else to the primary user_tenants row. After the rewrite, the helper
--    resolves to the primary row (tenant_id_for_policies(): is_primary desc, created_at, tenant_id), because browser JWTs
--    carry no top-level tenant_id claim. Counted from auth.users.raw_app_meta_data and user_tenants. Not counted: the
--    request.tenant_id setting and the top-level tenant / tenant_id JWT claims, which exist per request, not in the
--    database. Review the counts before the apply request. A live database may show non-zero counts.
WITH au AS (
  SELECT u.id AS user_id,
         CASE WHEN u.raw_app_meta_data ->> 'active_tenant_id'
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (u.raw_app_meta_data ->> 'active_tenant_id')::uuid
         END AS app_active
  FROM auth.users u
),
primary_row AS (
  SELECT DISTINCT ON (ut.user_id) ut.user_id, ut.tenant_id AS primary_tenant
  FROM public.user_tenants ut
  ORDER BY ut.user_id, ut.is_primary DESC, ut.created_at, ut.tenant_id
),
differ AS (
  SELECT au.user_id, au.app_active, pr.primary_tenant,
         EXISTS (SELECT 1 FROM public.user_tenants ut
                 WHERE ut.user_id = au.user_id AND ut.tenant_id = au.app_active) AS active_is_membership
  FROM au
  LEFT JOIN primary_row pr ON pr.user_id = au.user_id
  WHERE au.app_active IS NOT NULL
    AND au.app_active IS DISTINCT FROM pr.primary_tenant
)
SELECT count(*) FILTER (WHERE primary_tenant IS NULL) AS active_set_no_membership_row,
       count(*) FILTER (WHERE primary_tenant IS NOT NULL AND active_is_membership) AS active_set_non_primary_membership,
       count(*) FILTER (WHERE primary_tenant IS NOT NULL AND NOT active_is_membership) AS active_set_not_a_membership,
       count(*) AS total_resolving_differently
FROM differ;

-- 6b. Read-only: members with more than one membership, no is_primary row and no app_metadata.active_tenant_id. Today's
--     fallback takes an arbitrary row (LIMIT 1, no ORDER BY); the rewritten helper takes the earliest membership.
SELECT count(*) AS multi_membership_no_primary_no_active_tenant
FROM (
  SELECT ut.user_id
  FROM public.user_tenants ut
  GROUP BY ut.user_id
  HAVING count(*) > 1 AND NOT bool_or(ut.is_primary)
) m
WHERE NOT EXISTS (
  SELECT 1 FROM auth.users u
  WHERE u.id = m.user_id
    AND u.raw_app_meta_data ->> 'active_tenant_id' IS NOT NULL
);
