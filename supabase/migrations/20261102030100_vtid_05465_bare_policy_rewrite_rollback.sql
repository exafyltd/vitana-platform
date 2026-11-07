-- =============================================================================
-- VTID-05465 (mt-identity-r2 / helpers-and-policy-rewrite) — H4: ROLLBACK
-- -----------------------------------------------------------------------------
-- Pre-approved rollback of 20261102030100_vtid_05465_bare_policy_rewrite.sql
-- (and, last, of 20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql).
--
-- Restores each of the 32 rewritten policies exactly as the migration that
-- created it defined it (the "original:" comment above each one names the file
-- and line; the Jest test services/gateway/test/mt-identity-bare-policy-lint.test.ts
-- checks the text). The audience is the same before and after (plan amendment
-- 1): the rollback only puts current_tenant_id() back in place of
-- tenant_id_for_policies(), which makes the bare-policy lint read 32 again. Run
-- it only on the owner's approval of this file and the target database
-- (collaboration.md §7d). It is NOT a forward migration: never apply it as part
-- of the normal migration order. scripts/ci/bare-policy-lint.mjs skips it
-- because it pairs with the forward file of the same name.
--
-- Absent tables are skipped with a NOTICE, as in the forward migration.
-- The two helpers are dropped only when no policy and no other function body
-- references them any more; otherwise they stay and a NOTICE says why.
-- =============================================================================
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- community_groups
DO $rb$
BEGIN
  IF to_regclass('public.community_groups') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.community_groups is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20251231100000_vtid_01084_community_personalization_v1.sql:161
  DROP POLICY IF EXISTS community_groups_insert ON public.community_groups;
  CREATE POLICY community_groups_insert ON public.community_groups
      FOR INSERT
      TO authenticated
      WITH CHECK (
          tenant_id = public.current_tenant_id()
      );
  -- original: 20251231100000_vtid_01084_community_personalization_v1.sql:169
  DROP POLICY IF EXISTS community_groups_update ON public.community_groups;
  CREATE POLICY community_groups_update ON public.community_groups
      FOR UPDATE
      TO authenticated
      USING (
          tenant_id = public.current_tenant_id()
      );
  -- original: 20251231100000_vtid_01084_community_personalization_v1.sql:177
  DROP POLICY IF EXISTS community_groups_delete ON public.community_groups;
  CREATE POLICY community_groups_delete ON public.community_groups
      FOR DELETE
      TO authenticated
      USING (
          tenant_id = public.current_tenant_id()
      );
END
$rb$;

-- community_meetups
DO $rb$
BEGIN
  IF to_regclass('public.community_meetups') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.community_meetups is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20251231100000_vtid_01084_community_personalization_v1.sql:207
  DROP POLICY IF EXISTS community_meetups_insert ON public.community_meetups;
  CREATE POLICY community_meetups_insert ON public.community_meetups
      FOR INSERT
      TO authenticated
      WITH CHECK (
          tenant_id = public.current_tenant_id()
      );
  -- original: 20251231100000_vtid_01084_community_personalization_v1.sql:215
  DROP POLICY IF EXISTS community_meetups_update ON public.community_meetups;
  CREATE POLICY community_meetups_update ON public.community_meetups
      FOR UPDATE
      TO authenticated
      USING (
          tenant_id = public.current_tenant_id()
      );
  -- original: 20251231100000_vtid_01084_community_personalization_v1.sql:223
  DROP POLICY IF EXISTS community_meetups_delete ON public.community_meetups;
  CREATE POLICY community_meetups_delete ON public.community_meetups
      FOR DELETE
      TO authenticated
      USING (
          tenant_id = public.current_tenant_id()
      );
END
$rb$;

-- community_listings
DO $rb$
BEGIN
  IF to_regclass('public.community_listings') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.community_listings is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20260727090000_bootstrap_community_marketplace.sql:225
  DROP POLICY IF EXISTS community_listings_select_public ON public.community_listings;
  CREATE POLICY community_listings_select_public ON public.community_listings
    FOR SELECT TO authenticated
    USING (status IN ('active', 'paused', 'sold') AND tenant_id = public.current_tenant_id());
END
$rb$;

-- d42_domain_weights
DO $rb$
BEGIN
  IF to_regclass('public.d42_domain_weights') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.d42_domain_weights is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20260102000000_vtid_01136_context_fusion_engine.sql:204
  DROP POLICY IF EXISTS d42_domain_weights_select ON public.d42_domain_weights;
  CREATE POLICY d42_domain_weights_select ON public.d42_domain_weights
      FOR SELECT TO authenticated
      USING (tenant_id = public.current_tenant_id() OR tenant_id = '00000000-0000-0000-0000-000000000001'::UUID);
END
$rb$;

-- event_attendance
DO $rb$
BEGIN
  IF to_regclass('public.event_attendance') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.event_attendance is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20251231000001_vtid_01090_live_rooms_events_graph.sql:253
  DROP POLICY IF EXISTS event_attendance_select ON public.event_attendance;
  CREATE POLICY event_attendance_select ON public.event_attendance
      FOR SELECT
      TO authenticated
      USING (tenant_id = public.current_tenant_id());
END
$rb$;

-- live_highlights
DO $rb$
BEGIN
  IF to_regclass('public.live_highlights') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.live_highlights is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20251231000001_vtid_01090_live_rooms_events_graph.sql:314
  DROP POLICY IF EXISTS live_highlights_select ON public.live_highlights;
  CREATE POLICY live_highlights_select ON public.live_highlights
      FOR SELECT
      TO authenticated
      USING (tenant_id = public.current_tenant_id());
END
$rb$;

-- live_room_attendance
DO $rb$
BEGIN
  IF to_regclass('public.live_room_attendance') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.live_room_attendance is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20251231000001_vtid_01090_live_rooms_events_graph.sql:190
  DROP POLICY IF EXISTS live_room_attendance_select ON public.live_room_attendance;
  CREATE POLICY live_room_attendance_select ON public.live_room_attendance
      FOR SELECT
      TO authenticated
      USING (tenant_id = public.current_tenant_id());
END
$rb$;

-- live_rooms
DO $rb$
BEGIN
  IF to_regclass('public.live_rooms') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.live_rooms is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20251231000001_vtid_01090_live_rooms_events_graph.sql:128
  DROP POLICY IF EXISTS live_rooms_select ON public.live_rooms;
  CREATE POLICY live_rooms_select ON public.live_rooms
      FOR SELECT
      TO authenticated
      USING (tenant_id = public.current_tenant_id());
  -- original: 20251231000001_vtid_01090_live_rooms_events_graph.sql:134
  DROP POLICY IF EXISTS live_rooms_insert ON public.live_rooms;
  CREATE POLICY live_rooms_insert ON public.live_rooms
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = public.current_tenant_id());
  -- original: 20251231000001_vtid_01090_live_rooms_events_graph.sql:140
  DROP POLICY IF EXISTS live_rooms_update ON public.live_rooms;
  CREATE POLICY live_rooms_update ON public.live_rooms
      FOR UPDATE
      TO authenticated
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id());
END
$rb$;

-- products_catalog
DO $rb$
BEGIN
  IF to_regclass('public.products_catalog') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.products_catalog is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20251231100000_vtid_01092_services_products_memory.sql:159
  DROP POLICY IF EXISTS products_catalog_select ON public.products_catalog;
  CREATE POLICY products_catalog_select ON public.products_catalog
      FOR SELECT
      TO authenticated
      USING (tenant_id = public.current_tenant_id());
  -- original: 20251231100000_vtid_01092_services_products_memory.sql:165
  DROP POLICY IF EXISTS products_catalog_insert ON public.products_catalog;
  CREATE POLICY products_catalog_insert ON public.products_catalog
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = public.current_tenant_id());
END
$rb$;

-- services_catalog
DO $rb$
BEGIN
  IF to_regclass('public.services_catalog') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.services_catalog is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20251231100000_vtid_01092_services_products_memory.sql:146
  DROP POLICY IF EXISTS services_catalog_select ON public.services_catalog;
  CREATE POLICY services_catalog_select ON public.services_catalog
      FOR SELECT
      TO authenticated
      USING (tenant_id = public.current_tenant_id());
  -- original: 20251231100000_vtid_01092_services_products_memory.sql:152
  DROP POLICY IF EXISTS services_catalog_insert ON public.services_catalog;
  CREATE POLICY services_catalog_insert ON public.services_catalog
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = public.current_tenant_id());
END
$rb$;

-- tenant_catalog_overrides
DO $rb$
BEGIN
  IF to_regclass('public.tenant_catalog_overrides') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.tenant_catalog_overrides is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20260416120000_vtid_02000_marketplace_foundation.sql:809
  DROP POLICY IF EXISTS tenant_catalog_overrides_select ON public.tenant_catalog_overrides;
  CREATE POLICY tenant_catalog_overrides_select ON public.tenant_catalog_overrides
    FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
END
$rb$;

-- match_targets
DO $rb$
BEGIN
  IF to_regclass('public.match_targets') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.match_targets is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20251231000001_vtid_01088_matchmaking_engine.sql:238
  DROP POLICY IF EXISTS match_targets_select_policy ON public.match_targets;
  CREATE POLICY match_targets_select_policy ON public.match_targets
      FOR SELECT TO authenticated
      USING (tenant_id = public.current_tenant_id());
  -- original: 20251231000001_vtid_01088_matchmaking_engine.sql:242
  DROP POLICY IF EXISTS match_targets_insert_policy ON public.match_targets;
  CREATE POLICY match_targets_insert_policy ON public.match_targets
      FOR INSERT TO authenticated
      WITH CHECK (tenant_id = public.current_tenant_id());
  -- original: 20251231000001_vtid_01088_matchmaking_engine.sql:246
  DROP POLICY IF EXISTS match_targets_update_policy ON public.match_targets;
  CREATE POLICY match_targets_update_policy ON public.match_targets
      FOR UPDATE TO authenticated
      USING (tenant_id = public.current_tenant_id());
END
$rb$;

-- relationship_nodes
DO $rb$
BEGIN
  IF to_regclass('public.relationship_nodes') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.relationship_nodes is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20251231000001_vtid_01087_relationship_graph_memory.sql:134
  DROP POLICY IF EXISTS relationship_nodes_select ON public.relationship_nodes;
  CREATE POLICY relationship_nodes_select ON public.relationship_nodes
      FOR SELECT
      TO authenticated
      USING (tenant_id = public.current_tenant_id());
  -- original: 20251231000001_vtid_01087_relationship_graph_memory.sql:140
  DROP POLICY IF EXISTS relationship_nodes_insert ON public.relationship_nodes;
  CREATE POLICY relationship_nodes_insert ON public.relationship_nodes
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = public.current_tenant_id());
  -- original: 20251231000001_vtid_01087_relationship_graph_memory.sql:146
  DROP POLICY IF EXISTS relationship_nodes_update ON public.relationship_nodes;
  CREATE POLICY relationship_nodes_update ON public.relationship_nodes
      FOR UPDATE
      TO authenticated
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id());
  -- original: 20251231000001_vtid_01087_relationship_graph_memory.sql:153
  DROP POLICY IF EXISTS relationship_nodes_delete ON public.relationship_nodes;
  CREATE POLICY relationship_nodes_delete ON public.relationship_nodes
      FOR DELETE
      TO authenticated
      USING (tenant_id = public.current_tenant_id());
END
$rb$;

-- social_alignment_signals
DO $rb$
BEGIN
  IF to_regclass('public.social_alignment_signals') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.social_alignment_signals is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20260103000001_vtid_01141_d47_social_alignment_engine.sql:286
  DROP POLICY IF EXISTS social_alignment_signals_select ON public.social_alignment_signals;
  CREATE POLICY social_alignment_signals_select ON public.social_alignment_signals
      FOR SELECT
      TO authenticated
      USING (tenant_id = public.current_tenant_id());
  -- original: 20260103000001_vtid_01141_d47_social_alignment_engine.sql:293
  DROP POLICY IF EXISTS social_alignment_signals_insert ON public.social_alignment_signals;
  CREATE POLICY social_alignment_signals_insert ON public.social_alignment_signals
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = public.current_tenant_id());
END
$rb$;

-- topic_registry
DO $rb$
BEGIN
  IF to_regclass('public.topic_registry') IS NULL THEN
    RAISE NOTICE 'VTID-05465 rollback: public.topic_registry is absent; nothing to restore';
    RETURN;
  END IF;
  -- original: 20251231000001_vtid_01093_topics_layer.sql:73
  DROP POLICY IF EXISTS topic_registry_select ON public.topic_registry;
  CREATE POLICY topic_registry_select ON public.topic_registry
      FOR SELECT
      TO authenticated
      USING (tenant_id = public.current_tenant_id());
  -- original: 20251231000001_vtid_01093_topics_layer.sql:81
  DROP POLICY IF EXISTS topic_registry_insert ON public.topic_registry;
  CREATE POLICY topic_registry_insert ON public.topic_registry
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = public.current_tenant_id());
  -- original: 20251231000001_vtid_01093_topics_layer.sql:87
  DROP POLICY IF EXISTS topic_registry_update ON public.topic_registry;
  CREATE POLICY topic_registry_update ON public.topic_registry
      FOR UPDATE
      TO authenticated
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id());
  -- original: 20251231000001_vtid_01093_topics_layer.sql:94
  DROP POLICY IF EXISTS topic_registry_delete ON public.topic_registry;
  CREATE POLICY topic_registry_delete ON public.topic_registry
      FOR DELETE
      TO authenticated
      USING (tenant_id = public.current_tenant_id());
END
$rb$;

-- Helpers (20261102030000): drop only when nothing references them any more.
DO $helpers$
DECLARE
  n_pol int;
  n_fn int;
BEGIN
  SELECT count(*) INTO n_pol
  FROM pg_policies
  WHERE coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ '(is_member|tenant_id_for_policies)\(';
  SELECT count(*) INTO n_fn
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.proname NOT IN ('is_member', 'tenant_id_for_policies')
    AND p.prosrc ~ '(is_member|tenant_id_for_policies)\(';
  IF n_pol = 0 AND n_fn = 0 THEN
    DROP FUNCTION IF EXISTS public.is_member(uuid);
    DROP FUNCTION IF EXISTS public.tenant_id_for_policies();
  ELSE
    RAISE NOTICE 'VTID-05465 rollback: helpers kept (% policies, % functions still reference them)', n_pol, n_fn;
  END IF;
END
$helpers$;

COMMIT;
