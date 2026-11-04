-- mt-identity-r2 / helpers-and-policy-rewrite (VTID-05465) — throwaway-Postgres fixture.
-- The slice of the production schema the bare-policy rewrite touches: the 15 tables with their
-- 32 bare policies and the 7 health tables with their final policies, copied verbatim from the
-- migrations that define them last (file:line above each one), plus user_tenants and the auth
-- helpers. Tables carry only the columns the policies read. Local throwaway database only; never
-- a shared or live one. Order: this fixture, then
--   supabase/migrations/20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql
--   supabase/migrations/20261102030100_vtid_05465_bare_policy_rewrite.sql
--   supabase/tests/mt_identity_helpers_rls.test.sql
--   supabase/migrations/20261102030100_vtid_05465_bare_policy_rewrite_rollback.sql
--   supabase/tests/mt_identity_helpers_rollback.test.sql
-- (and the two forward migrations once more, to prove they re-apply). Needs pgTAP.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.user_tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    active_role TEXT NOT NULL DEFAULT 'community',
    is_primary BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_tenants_user ON public.user_tenants (user_id);
-- As in production: members read their own memberships (20251231000000_vtid_01101_phase_a_bootstrap.sql:111),
-- so the current_tenant_id() fallback below resolves for a signed-in member.
ALTER TABLE public.user_tenants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.user_tenants TO authenticated;
DROP POLICY IF EXISTS user_tenants_select_own ON public.user_tenants;
CREATE POLICY user_tenants_select_own ON public.user_tenants
    FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

-- current_tenant_id(), last definition: 20260218000000_fix_maxina_signup_tenant_association.sql:33
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_tenant_id UUID;
    v_jwt_claims JSONB;
BEGIN
    -- Priority 1: Request context GUC (set by dev_bootstrap or backend middleware)
    BEGIN
        v_tenant_id := current_setting('request.tenant_id', true)::UUID;
        IF v_tenant_id IS NOT NULL THEN
            RETURN v_tenant_id;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- Priority 2: JWT claims
    BEGIN
        v_jwt_claims := current_setting('request.jwt.claims', true)::JSONB;
        IF v_jwt_claims IS NOT NULL THEN
            -- Try top-level tenant_id claim
            v_tenant_id := (v_jwt_claims->>'tenant_id')::UUID;
            IF v_tenant_id IS NOT NULL THEN
                RETURN v_tenant_id;
            END IF;

            -- Try top-level tenant claim
            v_tenant_id := (v_jwt_claims->>'tenant')::UUID;
            IF v_tenant_id IS NOT NULL THEN
                RETURN v_tenant_id;
            END IF;

            -- Try app_metadata.active_tenant_id (set by frontend handle_new_user trigger)
            v_tenant_id := (v_jwt_claims->'app_metadata'->>'active_tenant_id')::UUID;
            IF v_tenant_id IS NOT NULL THEN
                RETURN v_tenant_id;
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    -- Priority 3: Fall back to user_tenants table (primary tenant)
    BEGIN
        SELECT tenant_id INTO v_tenant_id
        FROM public.user_tenants
        WHERE user_id = auth.uid()
          AND is_primary = true
        LIMIT 1;
        IF v_tenant_id IS NOT NULL THEN
            RETURN v_tenant_id;
        END IF;

        -- Any tenant for this user
        SELECT tenant_id INTO v_tenant_id
        FROM public.user_tenants
        WHERE user_id = auth.uid()
        LIMIT 1;
        IF v_tenant_id IS NOT NULL THEN
            RETURN v_tenant_id;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN NULL;
END;
$$;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated, service_role;

-- current_user_id(): 20251231000000_vtid_01078_health_brain_phase_c1.sql:23
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_user_id UUID;
BEGIN
    -- Try request context first (set by service_role calls)
    BEGIN
        v_user_id := current_setting('request.user_id', true)::UUID;
        IF v_user_id IS NOT NULL THEN
            RETURN v_user_id;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- Ignore errors from invalid UUID or missing setting
        NULL;
    END;

    -- Fallback to auth.uid() for authenticated users
    v_user_id := auth.uid();
    RETURN v_user_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.current_user_id() TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.community_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL
);
ALTER TABLE public.community_groups ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.community_groups TO authenticated;

CREATE TABLE IF NOT EXISTS public.community_meetups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL
);
ALTER TABLE public.community_meetups ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.community_meetups TO authenticated;

CREATE TABLE IF NOT EXISTS public.community_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
ALTER TABLE public.community_listings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.community_listings TO authenticated;

CREATE TABLE IF NOT EXISTS public.d42_domain_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL
);
ALTER TABLE public.d42_domain_weights ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.d42_domain_weights TO authenticated;

CREATE TABLE IF NOT EXISTS public.live_highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL
);
ALTER TABLE public.live_highlights ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_highlights TO authenticated;

CREATE TABLE IF NOT EXISTS public.live_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL
);
ALTER TABLE public.live_rooms ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_rooms TO authenticated;

CREATE TABLE IF NOT EXISTS public.products_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL
);
ALTER TABLE public.products_catalog ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products_catalog TO authenticated;

CREATE TABLE IF NOT EXISTS public.services_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL
);
ALTER TABLE public.services_catalog ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.services_catalog TO authenticated;

CREATE TABLE IF NOT EXISTS public.tenant_catalog_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL
);
ALTER TABLE public.tenant_catalog_overrides ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_catalog_overrides TO authenticated;

CREATE TABLE IF NOT EXISTS public.match_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL
);
ALTER TABLE public.match_targets ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.match_targets TO authenticated;

CREATE TABLE IF NOT EXISTS public.relationship_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL
);
ALTER TABLE public.relationship_nodes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.relationship_nodes TO authenticated;

CREATE TABLE IF NOT EXISTS public.social_alignment_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL
);
ALTER TABLE public.social_alignment_signals ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.social_alignment_signals TO authenticated;

CREATE TABLE IF NOT EXISTS public.topic_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL
);
ALTER TABLE public.topic_registry ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.topic_registry TO authenticated;

CREATE TABLE IF NOT EXISTS public.event_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL
);
ALTER TABLE public.event_attendance ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_attendance TO authenticated;

CREATE TABLE IF NOT EXISTS public.live_room_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL
);
ALTER TABLE public.live_room_attendance ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_room_attendance TO authenticated;

CREATE TABLE IF NOT EXISTS public.lab_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL
);
ALTER TABLE public.lab_reports ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lab_reports TO authenticated;

CREATE TABLE IF NOT EXISTS public.biomarker_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL
);
ALTER TABLE public.biomarker_results ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.biomarker_results TO authenticated;

CREATE TABLE IF NOT EXISTS public.wearable_samples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL
);
ALTER TABLE public.wearable_samples ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wearable_samples TO authenticated;

CREATE TABLE IF NOT EXISTS public.health_features_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL
);
ALTER TABLE public.health_features_daily ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.health_features_daily TO authenticated;

CREATE TABLE IF NOT EXISTS public.vitana_index_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL
);
ALTER TABLE public.vitana_index_scores ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vitana_index_scores TO authenticated;

CREATE TABLE IF NOT EXISTS public.recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL
);
ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recommendations TO authenticated;

CREATE TABLE IF NOT EXISTS public.safety_constraints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL
);
ALTER TABLE public.safety_constraints ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.safety_constraints TO authenticated;

-- The 32 bare policies (origin/main, last definition wins).
-- 20251231100000_vtid_01084_community_personalization_v1.sql:161
DROP POLICY IF EXISTS community_groups_insert ON public.community_groups;
CREATE POLICY community_groups_insert ON public.community_groups
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
    );
-- 20251231100000_vtid_01084_community_personalization_v1.sql:169
DROP POLICY IF EXISTS community_groups_update ON public.community_groups;
CREATE POLICY community_groups_update ON public.community_groups
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
    );
-- 20251231100000_vtid_01084_community_personalization_v1.sql:177
DROP POLICY IF EXISTS community_groups_delete ON public.community_groups;
CREATE POLICY community_groups_delete ON public.community_groups
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
    );
-- 20260727090000_bootstrap_community_marketplace.sql:225
DROP POLICY IF EXISTS community_listings_select_public ON public.community_listings;
CREATE POLICY community_listings_select_public ON public.community_listings
  FOR SELECT TO authenticated
  USING (status IN ('active', 'paused', 'sold') AND tenant_id = public.current_tenant_id());
-- 20251231100000_vtid_01084_community_personalization_v1.sql:207
DROP POLICY IF EXISTS community_meetups_insert ON public.community_meetups;
CREATE POLICY community_meetups_insert ON public.community_meetups
    FOR INSERT
    TO authenticated
    WITH CHECK (
        tenant_id = public.current_tenant_id()
    );
-- 20251231100000_vtid_01084_community_personalization_v1.sql:215
DROP POLICY IF EXISTS community_meetups_update ON public.community_meetups;
CREATE POLICY community_meetups_update ON public.community_meetups
    FOR UPDATE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
    );
-- 20251231100000_vtid_01084_community_personalization_v1.sql:223
DROP POLICY IF EXISTS community_meetups_delete ON public.community_meetups;
CREATE POLICY community_meetups_delete ON public.community_meetups
    FOR DELETE
    TO authenticated
    USING (
        tenant_id = public.current_tenant_id()
    );
-- 20260102000000_vtid_01136_context_fusion_engine.sql:204
DROP POLICY IF EXISTS d42_domain_weights_select ON public.d42_domain_weights;
CREATE POLICY d42_domain_weights_select ON public.d42_domain_weights
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id() OR tenant_id = '00000000-0000-0000-0000-000000000001'::UUID);
-- 20251231000001_vtid_01090_live_rooms_events_graph.sql:253
DROP POLICY IF EXISTS event_attendance_select ON public.event_attendance;
CREATE POLICY event_attendance_select ON public.event_attendance
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01090_live_rooms_events_graph.sql:314
DROP POLICY IF EXISTS live_highlights_select ON public.live_highlights;
CREATE POLICY live_highlights_select ON public.live_highlights
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01090_live_rooms_events_graph.sql:190
DROP POLICY IF EXISTS live_room_attendance_select ON public.live_room_attendance;
CREATE POLICY live_room_attendance_select ON public.live_room_attendance
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01090_live_rooms_events_graph.sql:128
DROP POLICY IF EXISTS live_rooms_select ON public.live_rooms;
CREATE POLICY live_rooms_select ON public.live_rooms
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01090_live_rooms_events_graph.sql:134
DROP POLICY IF EXISTS live_rooms_insert ON public.live_rooms;
CREATE POLICY live_rooms_insert ON public.live_rooms
    FOR INSERT
    TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01090_live_rooms_events_graph.sql:140
DROP POLICY IF EXISTS live_rooms_update ON public.live_rooms;
CREATE POLICY live_rooms_update ON public.live_rooms
    FOR UPDATE
    TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01088_matchmaking_engine.sql:238
DROP POLICY IF EXISTS match_targets_select_policy ON public.match_targets;
CREATE POLICY match_targets_select_policy ON public.match_targets
    FOR SELECT TO authenticated
    USING (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01088_matchmaking_engine.sql:242
DROP POLICY IF EXISTS match_targets_insert_policy ON public.match_targets;
CREATE POLICY match_targets_insert_policy ON public.match_targets
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01088_matchmaking_engine.sql:246
DROP POLICY IF EXISTS match_targets_update_policy ON public.match_targets;
CREATE POLICY match_targets_update_policy ON public.match_targets
    FOR UPDATE TO authenticated
    USING (tenant_id = public.current_tenant_id());
-- 20251231100000_vtid_01092_services_products_memory.sql:159
DROP POLICY IF EXISTS products_catalog_select ON public.products_catalog;
CREATE POLICY products_catalog_select ON public.products_catalog
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());
-- 20251231100000_vtid_01092_services_products_memory.sql:165
DROP POLICY IF EXISTS products_catalog_insert ON public.products_catalog;
CREATE POLICY products_catalog_insert ON public.products_catalog
    FOR INSERT
    TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01087_relationship_graph_memory.sql:134
DROP POLICY IF EXISTS relationship_nodes_select ON public.relationship_nodes;
CREATE POLICY relationship_nodes_select ON public.relationship_nodes
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01087_relationship_graph_memory.sql:140
DROP POLICY IF EXISTS relationship_nodes_insert ON public.relationship_nodes;
CREATE POLICY relationship_nodes_insert ON public.relationship_nodes
    FOR INSERT
    TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01087_relationship_graph_memory.sql:146
DROP POLICY IF EXISTS relationship_nodes_update ON public.relationship_nodes;
CREATE POLICY relationship_nodes_update ON public.relationship_nodes
    FOR UPDATE
    TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01087_relationship_graph_memory.sql:153
DROP POLICY IF EXISTS relationship_nodes_delete ON public.relationship_nodes;
CREATE POLICY relationship_nodes_delete ON public.relationship_nodes
    FOR DELETE
    TO authenticated
    USING (tenant_id = public.current_tenant_id());
-- 20251231100000_vtid_01092_services_products_memory.sql:146
DROP POLICY IF EXISTS services_catalog_select ON public.services_catalog;
CREATE POLICY services_catalog_select ON public.services_catalog
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());
-- 20251231100000_vtid_01092_services_products_memory.sql:152
DROP POLICY IF EXISTS services_catalog_insert ON public.services_catalog;
CREATE POLICY services_catalog_insert ON public.services_catalog
    FOR INSERT
    TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
-- 20260103000001_vtid_01141_d47_social_alignment_engine.sql:286
DROP POLICY IF EXISTS social_alignment_signals_select ON public.social_alignment_signals;
CREATE POLICY social_alignment_signals_select ON public.social_alignment_signals
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());
-- 20260103000001_vtid_01141_d47_social_alignment_engine.sql:293
DROP POLICY IF EXISTS social_alignment_signals_insert ON public.social_alignment_signals;
CREATE POLICY social_alignment_signals_insert ON public.social_alignment_signals
    FOR INSERT
    TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
-- 20260416120000_vtid_02000_marketplace_foundation.sql:809
DROP POLICY IF EXISTS tenant_catalog_overrides_select ON public.tenant_catalog_overrides;
CREATE POLICY tenant_catalog_overrides_select ON public.tenant_catalog_overrides
  FOR SELECT TO authenticated USING (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01093_topics_layer.sql:73
DROP POLICY IF EXISTS topic_registry_select ON public.topic_registry;
CREATE POLICY topic_registry_select ON public.topic_registry
    FOR SELECT
    TO authenticated
    USING (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01093_topics_layer.sql:81
DROP POLICY IF EXISTS topic_registry_insert ON public.topic_registry;
CREATE POLICY topic_registry_insert ON public.topic_registry
    FOR INSERT
    TO authenticated
    WITH CHECK (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01093_topics_layer.sql:87
DROP POLICY IF EXISTS topic_registry_update ON public.topic_registry;
CREATE POLICY topic_registry_update ON public.topic_registry
    FOR UPDATE
    TO authenticated
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
-- 20251231000001_vtid_01093_topics_layer.sql:94
DROP POLICY IF EXISTS topic_registry_delete ON public.topic_registry;
CREATE POLICY topic_registry_delete ON public.topic_registry
    FOR DELETE
    TO authenticated
    USING (tenant_id = public.current_tenant_id());

-- The health tables' final policies (checked read-only by the test).
-- 20251231000000_vtid_01103_health_compute_engine.sql:144
DROP POLICY IF EXISTS biomarker_results_user_policy ON public.biomarker_results;
CREATE POLICY biomarker_results_user_policy ON public.biomarker_results
    FOR ALL USING (user_id = auth.uid());
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:293
DROP POLICY IF EXISTS biomarker_results_select ON public.biomarker_results;
CREATE POLICY biomarker_results_select ON public.biomarker_results
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:300
DROP POLICY IF EXISTS biomarker_results_insert ON public.biomarker_results;
CREATE POLICY biomarker_results_insert ON public.biomarker_results
    FOR INSERT WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:307
DROP POLICY IF EXISTS biomarker_results_update ON public.biomarker_results;
CREATE POLICY biomarker_results_update ON public.biomarker_results
    FOR UPDATE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:314
DROP POLICY IF EXISTS biomarker_results_delete ON public.biomarker_results;
CREATE POLICY biomarker_results_delete ON public.biomarker_results
    FOR DELETE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01103_health_compute_engine.sql:147
DROP POLICY IF EXISTS health_features_daily_user_policy ON public.health_features_daily;
CREATE POLICY health_features_daily_user_policy ON public.health_features_daily
    FOR ALL USING (user_id = auth.uid());
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:357
DROP POLICY IF EXISTS health_features_daily_select ON public.health_features_daily;
CREATE POLICY health_features_daily_select ON public.health_features_daily
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:364
DROP POLICY IF EXISTS health_features_daily_insert ON public.health_features_daily;
CREATE POLICY health_features_daily_insert ON public.health_features_daily
    FOR INSERT WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:371
DROP POLICY IF EXISTS health_features_daily_update ON public.health_features_daily;
CREATE POLICY health_features_daily_update ON public.health_features_daily
    FOR UPDATE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:378
DROP POLICY IF EXISTS health_features_daily_delete ON public.health_features_daily;
CREATE POLICY health_features_daily_delete ON public.health_features_daily
    FOR DELETE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20260918100000_vtid_04044_lab_reports_rls_user_scoped.sql:63
DROP POLICY IF EXISTS lab_reports_user_policy ON public.lab_reports;
CREATE POLICY lab_reports_user_policy ON public.lab_reports
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
-- 20251231000000_vtid_01103_health_compute_engine.sql:153
DROP POLICY IF EXISTS recommendations_user_policy ON public.recommendations;
CREATE POLICY recommendations_user_policy ON public.recommendations
    FOR ALL USING (user_id = auth.uid());
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:421
DROP POLICY IF EXISTS recommendations_select ON public.recommendations;
CREATE POLICY recommendations_select ON public.recommendations
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:428
DROP POLICY IF EXISTS recommendations_insert ON public.recommendations;
CREATE POLICY recommendations_insert ON public.recommendations
    FOR INSERT WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:435
DROP POLICY IF EXISTS recommendations_update ON public.recommendations;
CREATE POLICY recommendations_update ON public.recommendations
    FOR UPDATE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:442
DROP POLICY IF EXISTS recommendations_delete ON public.recommendations;
CREATE POLICY recommendations_delete ON public.recommendations
    FOR DELETE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:453
DROP POLICY IF EXISTS safety_constraints_select ON public.safety_constraints;
CREATE POLICY safety_constraints_select ON public.safety_constraints
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:460
DROP POLICY IF EXISTS safety_constraints_insert ON public.safety_constraints;
CREATE POLICY safety_constraints_insert ON public.safety_constraints
    FOR INSERT WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:467
DROP POLICY IF EXISTS safety_constraints_update ON public.safety_constraints;
CREATE POLICY safety_constraints_update ON public.safety_constraints
    FOR UPDATE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:474
DROP POLICY IF EXISTS safety_constraints_delete ON public.safety_constraints;
CREATE POLICY safety_constraints_delete ON public.safety_constraints
    FOR DELETE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20260423081500_vitana_index_scores_rls_simplify.sql:33
DROP POLICY IF EXISTS vitana_index_scores_user_policy ON public.vitana_index_scores;
CREATE POLICY vitana_index_scores_user_policy ON public.vitana_index_scores
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
-- 20251231000000_vtid_01103_health_compute_engine.sql:141
DROP POLICY IF EXISTS wearable_samples_user_policy ON public.wearable_samples;
CREATE POLICY wearable_samples_user_policy ON public.wearable_samples
    FOR ALL USING (user_id = auth.uid());
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:325
DROP POLICY IF EXISTS wearable_samples_select ON public.wearable_samples;
CREATE POLICY wearable_samples_select ON public.wearable_samples
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:332
DROP POLICY IF EXISTS wearable_samples_insert ON public.wearable_samples;
CREATE POLICY wearable_samples_insert ON public.wearable_samples
    FOR INSERT WITH CHECK (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:339
DROP POLICY IF EXISTS wearable_samples_update ON public.wearable_samples;
CREATE POLICY wearable_samples_update ON public.wearable_samples
    FOR UPDATE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );
-- 20251231000000_vtid_01078_health_brain_phase_c1.sql:346
DROP POLICY IF EXISTS wearable_samples_delete ON public.wearable_samples;
CREATE POLICY wearable_samples_delete ON public.wearable_samples
    FOR DELETE USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

-- Fixture scaffolding (not a production policy): community_groups and community_meetups have no
-- bare SELECT policy, and an UPDATE/DELETE with a WHERE clause only reaches rows a SELECT policy
-- shows. Their real SELECT policies need community_memberships; this stand-in shows every row so
-- the test isolates the rewritten write policies.
DROP POLICY IF EXISTS fixture_select_all ON public.community_groups;
CREATE POLICY fixture_select_all ON public.community_groups FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS fixture_select_all ON public.community_meetups;
CREATE POLICY fixture_select_all ON public.community_meetups FOR SELECT TO authenticated USING (true);

-- Tenants A and B, the global-defaults tenant ...0001 (d42_domain_weights) and four users:
--   a_admin  ...0a5401  A (primary)        a_member ...0a5402  A (primary)
--   b_member ...0b5403  B (primary)        ab_member ...0c5404 A (primary) and B
INSERT INTO public.user_tenants (tenant_id, user_id, active_role, is_primary) VALUES
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5401', 'admin', true),
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5402', 'community', true),
  ('0000000b-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000b5403', 'community', true),
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000c5404', 'community', true),
  ('0000000b-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000c5404', 'community', false)
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- Background memberships so the planner sees a realistic user_tenants (EXPLAIN check).
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary)
SELECT ('00000000-0000-0000-0000-' || lpad(to_hex(g % 50), 12, '0'))::uuid,
       ('00000000-0000-0000-0001-' || lpad(to_hex(g), 12, '0'))::uuid, true
FROM generate_series(1, 5000) g
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- auth.users, only the two columns the membership count in pre-check.sql (section 6) reads. app_metadata.active_tenant_id
-- is what the 20260218 body falls back to. ab_member's active tenant is its non-primary membership (B). User ...0d5405
-- has no user_tenants row: today's body still admits it to tenant A, the rewritten helper returns NULL.
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY,
  raw_app_meta_data JSONB NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO auth.users (id, raw_app_meta_data) VALUES
  ('00000000-0000-0000-0000-0000000a5401', '{"active_tenant_id": "0000000a-0000-0000-0000-000000005465"}'),
  ('00000000-0000-0000-0000-0000000a5402', '{"active_tenant_id": "0000000a-0000-0000-0000-000000005465"}'),
  ('00000000-0000-0000-0000-0000000b5403', '{"active_tenant_id": "0000000b-0000-0000-0000-000000005465"}'),
  ('00000000-0000-0000-0000-0000000c5404', '{"active_tenant_id": "0000000b-0000-0000-0000-000000005465"}'),
  ('00000000-0000-0000-0000-0000000d5405', '{"active_tenant_id": "0000000a-0000-0000-0000-000000005465"}')
ON CONFLICT (id) DO NOTHING;

-- One row per tenant on every tenant-shared table.
INSERT INTO public.community_groups (tenant_id) VALUES ('0000000a-0000-0000-0000-000000005465'), ('0000000b-0000-0000-0000-000000005465');
INSERT INTO public.community_meetups (tenant_id) VALUES ('0000000a-0000-0000-0000-000000005465'), ('0000000b-0000-0000-0000-000000005465');
INSERT INTO public.community_listings (tenant_id, status) VALUES
  ('0000000a-0000-0000-0000-000000005465', 'active'), ('0000000a-0000-0000-0000-000000005465', 'draft'),
  ('0000000b-0000-0000-0000-000000005465', 'active');
INSERT INTO public.d42_domain_weights (tenant_id) VALUES
  ('0000000a-0000-0000-0000-000000005465'), ('0000000b-0000-0000-0000-000000005465'), ('00000000-0000-0000-0000-000000000001');
INSERT INTO public.live_highlights (tenant_id) VALUES ('0000000a-0000-0000-0000-000000005465'), ('0000000b-0000-0000-0000-000000005465');
INSERT INTO public.live_rooms (tenant_id) VALUES ('0000000a-0000-0000-0000-000000005465'), ('0000000b-0000-0000-0000-000000005465');
INSERT INTO public.products_catalog (tenant_id) VALUES ('0000000a-0000-0000-0000-000000005465'), ('0000000b-0000-0000-0000-000000005465');
INSERT INTO public.services_catalog (tenant_id) VALUES ('0000000a-0000-0000-0000-000000005465'), ('0000000b-0000-0000-0000-000000005465');
INSERT INTO public.tenant_catalog_overrides (tenant_id) VALUES ('0000000a-0000-0000-0000-000000005465'), ('0000000b-0000-0000-0000-000000005465');
INSERT INTO public.match_targets (tenant_id) VALUES ('0000000a-0000-0000-0000-000000005465'), ('0000000b-0000-0000-0000-000000005465');
INSERT INTO public.relationship_nodes (tenant_id) VALUES ('0000000a-0000-0000-0000-000000005465'), ('0000000b-0000-0000-0000-000000005465');
INSERT INTO public.social_alignment_signals (tenant_id) VALUES ('0000000a-0000-0000-0000-000000005465'), ('0000000b-0000-0000-0000-000000005465');
INSERT INTO public.topic_registry (tenant_id) VALUES ('0000000a-0000-0000-0000-000000005465'), ('0000000b-0000-0000-0000-000000005465');
INSERT INTO public.live_rooms (tenant_id)
SELECT ('00000000-0000-0000-0000-' || lpad(to_hex(g % 50), 12, '0'))::uuid FROM generate_series(1, 2000) g;

-- a_admin, a_member (tenant A) and b_member (tenant B) rows on every user-private and health table.
INSERT INTO public.event_attendance (tenant_id, user_id) VALUES
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5401'),
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5402'),
  ('0000000b-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000b5403');
INSERT INTO public.live_room_attendance (tenant_id, user_id) VALUES
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5401'),
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5402'),
  ('0000000b-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000b5403');
INSERT INTO public.lab_reports (tenant_id, user_id) VALUES
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5401'),
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5402'),
  ('0000000b-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000b5403');
INSERT INTO public.biomarker_results (tenant_id, user_id) VALUES
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5401'),
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5402'),
  ('0000000b-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000b5403');
INSERT INTO public.wearable_samples (tenant_id, user_id) VALUES
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5401'),
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5402'),
  ('0000000b-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000b5403');
INSERT INTO public.health_features_daily (tenant_id, user_id) VALUES
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5401'),
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5402'),
  ('0000000b-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000b5403');
INSERT INTO public.vitana_index_scores (tenant_id, user_id) VALUES
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5401'),
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5402'),
  ('0000000b-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000b5403');
INSERT INTO public.recommendations (tenant_id, user_id) VALUES
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5401'),
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5402'),
  ('0000000b-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000b5403');
INSERT INTO public.safety_constraints (tenant_id, user_id) VALUES
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5401'),
  ('0000000a-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000a5402'),
  ('0000000b-0000-0000-0000-000000005465', '00000000-0000-0000-0000-0000000b5403');

ANALYZE public.user_tenants;
ANALYZE public.live_rooms;
