-- =============================================================================
-- VTID-05465 (mt-identity-r2 / helpers-and-policy-rewrite) — H2: bare-policy rewrite
-- -----------------------------------------------------------------------------
-- Rewrites every bare `tenant_id = current_tenant_id()` policy (no auth.uid(),
-- current_user_id(), is_member(), is_tenant_admin() or service-role check) to
-- the new helper name, so the bare-policy lint reads 0 before a later lane
-- redefines current_tenant_id() (N3 ordering gate). Recount at implementation
-- (scripts/ci/bare-policy-lint.mjs over every supabase/migrations/*.sql on
-- origin/main 50e55fd3a4, last definition wins): 32 policies on 15 tables, the
-- same set as the 2026-11-01 recount.
--
-- Plan amendment 1 (2026-11-02): the bare policies do not fail closed today, if the live current_tenant_id() is the
-- 20260218 body. That is not verified against the live database; the live-body guard in DO $pre$ checks it.
-- current_tenant_id() (20260218000000_fix_maxina_signup_tenant_association.sql:33-103)
-- falls back to app_metadata.active_tenant_id and then to the caller's
-- user_tenants row, so each policy already admits the members of the caller's
-- resolved tenant. This migration keeps that audience on every policy, reads
-- included, and only changes the helper:
--     tenant_id = current_tenant_id()
--  -> tenant_id = (select public.tenant_id_for_policies())
-- No policy gains a user_id = auth.uid() term and none uses is_member()
-- (is_member() is created for later lanes only). Narrowing user-private reads
-- and multi-tenant reads are later, separately sparred decisions.
--   Extra predicates kept: community_listings_select_public keeps its
--   status IN (...) term; d42_domain_weights_select keeps its global-defaults
--   OR tenant_id = '...0001' term.
-- Policy names, commands, roles (TO authenticated) and the USING / WITH CHECK
-- shape of every policy stay as they are. Write policies keep today's audience:
-- any member of the resolved tenant. Nothing is tightened to admins here.
--
-- Not touched: current_tenant_id() (redefining it is a later go-live lane),
-- the access-token hook, and the 5 tables with no policy and no CREATE TABLE in
-- either repo (WS2/WS10).
--
-- Guards, all in this one transaction:
--   * the helpers of 20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql
--     must exist;
--   * the live current_tenant_id() body must be the 20260218 body (three markers, DO $pre$). On the 20251229 body
--     the migration refuses, so the rewrite never runs there (acceptance.md, AC-12);
--   * a table that is absent on the target is skipped with a NOTICE (8 of the 15
--     are listed in scripts/ci/migration-drift-baseline.json as declared but
--     absent in production);
--   * on a present table, each of its policies must exist live with the same
--     command, role authenticated and a current_tenant_id() filter (or, on a
--     re-run, the rewritten filter), else the migration refuses, so the
--     rollback restores what was live;
--   * post-check: none of the 32 policies still references current_tenant_id().
--
-- Applying it needs the owner's approval of this file and the target database
-- (collaboration.md §7d), after 20261102030000. Rollback:
-- 20261102030100_vtid_05465_bare_policy_rewrite_rollback.sql (pre-approved).
-- =============================================================================
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
DECLARE
  r record;
  p record;
  v_def text;
  v_ok_app_metadata boolean;
  v_ok_user_tenants boolean;
  v_ok_own_lookup boolean;
BEGIN
  IF to_regprocedure('public.is_member(uuid)') IS NULL
     OR to_regprocedure('public.tenant_id_for_policies()') IS NULL THEN
    RAISE EXCEPTION 'VTID-05465: apply 20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql first';
  END IF;

  -- Live-body guard (VTID-05465 review, 2026-11-02). The rewrite is correct only if the live current_tenant_id()
  -- is the 20260218 body (20260218000000_fix_maxina_signup_tenant_association.sql:33-103). That body falls back to
  -- app_metadata.active_tenant_id and then to the caller's user_tenants row, so today's bare policies admit the
  -- members of the caller's resolved tenant. The 20251229 body (20251229000000_vtid_01051_me_active_role_fix.sql:15-58)
  -- reads only the request.tenant_id setting and the top-level tenant_id / tenant claims. A browser JWT carries neither,
  -- so that body resolves to NULL and the bare policies admit nothing. The docs say the 20251229 body is the one live
  -- (docs/MULTI-TENANT-PLAN.md:24, docs/DATABASE_SCHEMA.md:3320-3322). If so, the rewrite would open every one of the
  -- 32 policies to every member of the caller's primary tenant. The guard reads the live definition and refuses unless
  -- all three markers below match. Each marker is a code fragment that the 20260218 body contains and the 20251229 body
  -- does not (the 20251229 file has no "app_metadata" at all). Comments are not markers: a comment edit does not
  -- change behaviour. The markers:
  --   marker 1  v_jwt_claims->'app_metadata'->>'active_tenant_id'   the app_metadata fallback
  --   marker 2  FROM public.user_tenants                             the membership fallback
  --   marker 3  WHERE user_id = auth.uid()                           the caller's own membership lookup
  -- The NOTICE lines print the first 200 characters of the live body and each marker's result.
  IF to_regprocedure('public.current_tenant_id()') IS NULL THEN
    RAISE EXCEPTION 'VTID-05465: public.current_tenant_id() does not exist; refusing the rewrite';
  END IF;
  v_def := pg_get_functiondef('public.current_tenant_id()'::regprocedure);
  v_ok_app_metadata := position('v_jwt_claims->''app_metadata''->>''active_tenant_id''' IN v_def) > 0;
  v_ok_user_tenants := position('FROM public.user_tenants' IN v_def) > 0;
  v_ok_own_lookup := position('WHERE user_id = auth.uid()' IN v_def) > 0;
  RAISE NOTICE 'VTID-05465 live current_tenant_id() body, first 200 characters: %', left(v_def, 200);
  RAISE NOTICE 'VTID-05465 live-body marker 1 (app_metadata.active_tenant_id fallback) matched: %', v_ok_app_metadata;
  RAISE NOTICE 'VTID-05465 live-body marker 2 (user_tenants fallback) matched: %', v_ok_user_tenants;
  RAISE NOTICE 'VTID-05465 live-body marker 3 (own membership lookup) matched: %', v_ok_own_lookup;
  IF NOT (v_ok_app_metadata AND v_ok_user_tenants AND v_ok_own_lookup) THEN
    RAISE EXCEPTION 'VTID-05465: the live current_tenant_id() is not the 20260218 body (markers %, %, %); refusing the rewrite. The lane is parked for an owner decision (docs/validation/VTID-05465/acceptance.md)', v_ok_app_metadata, v_ok_user_tenants, v_ok_own_lookup;
  END IF;

  FOR r IN SELECT * FROM (VALUES
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
    ) AS s(tbl, pol, cmd) LOOP
    CONTINUE WHEN to_regclass('public.' || r.tbl) IS NULL;
    SELECT * INTO p FROM pg_policies WHERE schemaname = 'public' AND tablename = r.tbl AND policyname = r.pol;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VTID-05465: policy %.% is not live; refusing (live drift)', r.tbl, r.pol;
    END IF;
    -- Either the original form (current_tenant_id()) or, on a re-run, the
    -- rewritten form (tenant_id_for_policies).
    IF p.cmd <> r.cmd OR p.roles <> ARRAY['authenticated']::name[]
       OR coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')
          !~ '(current_tenant_id|tenant_id_for_policies)\(' THEN
      RAISE EXCEPTION 'VTID-05465: live policy %.% differs from its migration (cmd %, roles %); refusing', r.tbl, r.pol, p.cmd, p.roles;
    END IF;
  END LOOP;
END
$pre$;

-- community_groups
DO $rw$
BEGIN
  IF to_regclass('public.community_groups') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.community_groups is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS community_groups_insert ON public.community_groups;
  CREATE POLICY community_groups_insert ON public.community_groups
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS community_groups_update ON public.community_groups;
  CREATE POLICY community_groups_update ON public.community_groups
      FOR UPDATE
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS community_groups_delete ON public.community_groups;
  CREATE POLICY community_groups_delete ON public.community_groups
      FOR DELETE
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- community_meetups
DO $rw$
BEGIN
  IF to_regclass('public.community_meetups') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.community_meetups is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS community_meetups_insert ON public.community_meetups;
  CREATE POLICY community_meetups_insert ON public.community_meetups
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS community_meetups_update ON public.community_meetups;
  CREATE POLICY community_meetups_update ON public.community_meetups
      FOR UPDATE
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS community_meetups_delete ON public.community_meetups;
  CREATE POLICY community_meetups_delete ON public.community_meetups
      FOR DELETE
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- community_listings
DO $rw$
BEGIN
  IF to_regclass('public.community_listings') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.community_listings is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS community_listings_select_public ON public.community_listings;
  CREATE POLICY community_listings_select_public ON public.community_listings
      FOR SELECT
      TO authenticated
      USING (status IN ('active', 'paused', 'sold') AND tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- d42_domain_weights
DO $rw$
BEGIN
  IF to_regclass('public.d42_domain_weights') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.d42_domain_weights is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS d42_domain_weights_select ON public.d42_domain_weights;
  CREATE POLICY d42_domain_weights_select ON public.d42_domain_weights
      FOR SELECT
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()) OR tenant_id = '00000000-0000-0000-0000-000000000001'::UUID);
END
$rw$;

-- event_attendance
DO $rw$
BEGIN
  IF to_regclass('public.event_attendance') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.event_attendance is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS event_attendance_select ON public.event_attendance;
  CREATE POLICY event_attendance_select ON public.event_attendance
      FOR SELECT
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- live_highlights
DO $rw$
BEGIN
  IF to_regclass('public.live_highlights') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.live_highlights is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS live_highlights_select ON public.live_highlights;
  CREATE POLICY live_highlights_select ON public.live_highlights
      FOR SELECT
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- live_room_attendance
DO $rw$
BEGIN
  IF to_regclass('public.live_room_attendance') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.live_room_attendance is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS live_room_attendance_select ON public.live_room_attendance;
  CREATE POLICY live_room_attendance_select ON public.live_room_attendance
      FOR SELECT
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- live_rooms
DO $rw$
BEGIN
  IF to_regclass('public.live_rooms') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.live_rooms is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS live_rooms_select ON public.live_rooms;
  CREATE POLICY live_rooms_select ON public.live_rooms
      FOR SELECT
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS live_rooms_insert ON public.live_rooms;
  CREATE POLICY live_rooms_insert ON public.live_rooms
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS live_rooms_update ON public.live_rooms;
  CREATE POLICY live_rooms_update ON public.live_rooms
      FOR UPDATE
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()))
      WITH CHECK (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- products_catalog
DO $rw$
BEGIN
  IF to_regclass('public.products_catalog') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.products_catalog is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS products_catalog_select ON public.products_catalog;
  CREATE POLICY products_catalog_select ON public.products_catalog
      FOR SELECT
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS products_catalog_insert ON public.products_catalog;
  CREATE POLICY products_catalog_insert ON public.products_catalog
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- services_catalog
DO $rw$
BEGIN
  IF to_regclass('public.services_catalog') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.services_catalog is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS services_catalog_select ON public.services_catalog;
  CREATE POLICY services_catalog_select ON public.services_catalog
      FOR SELECT
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS services_catalog_insert ON public.services_catalog;
  CREATE POLICY services_catalog_insert ON public.services_catalog
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- tenant_catalog_overrides
DO $rw$
BEGIN
  IF to_regclass('public.tenant_catalog_overrides') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.tenant_catalog_overrides is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS tenant_catalog_overrides_select ON public.tenant_catalog_overrides;
  CREATE POLICY tenant_catalog_overrides_select ON public.tenant_catalog_overrides
      FOR SELECT
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- match_targets
DO $rw$
BEGIN
  IF to_regclass('public.match_targets') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.match_targets is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS match_targets_select_policy ON public.match_targets;
  CREATE POLICY match_targets_select_policy ON public.match_targets
      FOR SELECT
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS match_targets_insert_policy ON public.match_targets;
  CREATE POLICY match_targets_insert_policy ON public.match_targets
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS match_targets_update_policy ON public.match_targets;
  CREATE POLICY match_targets_update_policy ON public.match_targets
      FOR UPDATE
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- relationship_nodes
DO $rw$
BEGIN
  IF to_regclass('public.relationship_nodes') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.relationship_nodes is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS relationship_nodes_select ON public.relationship_nodes;
  CREATE POLICY relationship_nodes_select ON public.relationship_nodes
      FOR SELECT
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS relationship_nodes_insert ON public.relationship_nodes;
  CREATE POLICY relationship_nodes_insert ON public.relationship_nodes
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS relationship_nodes_update ON public.relationship_nodes;
  CREATE POLICY relationship_nodes_update ON public.relationship_nodes
      FOR UPDATE
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()))
      WITH CHECK (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS relationship_nodes_delete ON public.relationship_nodes;
  CREATE POLICY relationship_nodes_delete ON public.relationship_nodes
      FOR DELETE
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- social_alignment_signals
DO $rw$
BEGIN
  IF to_regclass('public.social_alignment_signals') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.social_alignment_signals is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS social_alignment_signals_select ON public.social_alignment_signals;
  CREATE POLICY social_alignment_signals_select ON public.social_alignment_signals
      FOR SELECT
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS social_alignment_signals_insert ON public.social_alignment_signals;
  CREATE POLICY social_alignment_signals_insert ON public.social_alignment_signals
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

-- topic_registry
DO $rw$
BEGIN
  IF to_regclass('public.topic_registry') IS NULL THEN
    RAISE NOTICE 'VTID-05465: public.topic_registry is absent; nothing to rewrite';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS topic_registry_select ON public.topic_registry;
  CREATE POLICY topic_registry_select ON public.topic_registry
      FOR SELECT
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS topic_registry_insert ON public.topic_registry;
  CREATE POLICY topic_registry_insert ON public.topic_registry
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS topic_registry_update ON public.topic_registry;
  CREATE POLICY topic_registry_update ON public.topic_registry
      FOR UPDATE
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()))
      WITH CHECK (tenant_id = (select public.tenant_id_for_policies()));
  DROP POLICY IF EXISTS topic_registry_delete ON public.topic_registry;
  CREATE POLICY topic_registry_delete ON public.topic_registry
      FOR DELETE
      TO authenticated
      USING (tenant_id = (select public.tenant_id_for_policies()));
END
$rw$;

DO $post$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
  FROM pg_policies p
  JOIN (VALUES
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
    ) AS s(tbl, pol, cmd) ON s.tbl = p.tablename AND s.pol = p.policyname
  WHERE p.schemaname = 'public'
    AND position('current_tenant_id()' IN coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) > 0;
  IF n > 0 THEN
    RAISE EXCEPTION 'VTID-05465: % rewritten policies still reference current_tenant_id()', n;
  END IF;
END
$post$;

COMMIT;
