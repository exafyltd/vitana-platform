-- Purpose: VTID-03885 Partner Health Test Integration — reusable Partner
--          Health Data Loop, with DoctorBox as Partner #001.
-- Date: 2026-09-14
--
-- Deliberately does NOT touch `lab_tests` / `lab_test_orders` /
-- `lab_test_results` — those are Lovable-side commerce "ghost tables",
-- explicitly declared out of scope by the VTID-03186 Universal Cart
-- migration pending a separate convergence decision (issue #2371 /
-- VTID-03176). This migration introduces its own, separate model instead.
--
-- Also does NOT alter `biomarker_results` (verified live shape: the
-- VTID-01078 column set — biomarker_code/ref_range_low/ref_range_high —
-- is what's actually deployed) or `lab_test_orders`'s sibling tables.
-- Validated partner results are projected into the existing
-- `biomarker_results`/`lab_reports` tables by application code, not by
-- this migration.

-- ===========================================================================
-- 1. partner_registry — the partner catalog (framework root)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.partner_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    integration_mode TEXT NOT NULL DEFAULT 'portal_manual'
        CHECK (integration_mode IN ('portal_manual', 'webhook', 'api_sync')),
    status TEXT NOT NULL DEFAULT 'sandbox'
        CHECK (status IN ('active', 'sandbox', 'disabled')),
    capabilities JSONB NOT NULL DEFAULT '{"has_order_api": false, "has_webhook": false, "has_result_api": false}'::JSONB,
    config JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.partner_registry IS 'VTID-03885: Partner Health Test Integration — one row per connected health-test partner (DoctorBox = Partner #001). capabilities tracks what is REALLY wired vs. aspirational.';

-- ===========================================================================
-- 2. partner_customer_links — Vitana user <-> partner's own reference
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.partner_customer_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID, -- nullable: unmatched rows are expected and must never be guessed
    partner_id UUID NOT NULL REFERENCES public.partner_registry(id) ON DELETE CASCADE,
    external_customer_ref TEXT,
    match_confidence TEXT NOT NULL DEFAULT 'unmatched'
        CHECK (match_confidence IN ('deterministic', 'manual_confirmed', 'unmatched')),
    matched_by_admin_id UUID,
    matched_at TIMESTAMPTZ,
    source_click_id TEXT, -- correlates to product_clicks.click_id (informational, not a hard FK)
    raw JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_customer_links_partner_ref_matched_uidx
    ON public.partner_customer_links (partner_id, external_customer_ref)
    WHERE match_confidence != 'unmatched' AND external_customer_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS partner_customer_links_user_idx ON public.partner_customer_links (tenant_id, user_id);

COMMENT ON TABLE public.partner_customer_links IS 'VTID-03885: External partner customer/order reference resolved (or not yet resolved) to a Vitana user_id. Never auto-resolved past "unmatched" without an explicit admin confirmation — see partner_health_result_inbox.';

-- ===========================================================================
-- 3. partner_health_test_orders — order/test/sample chain + canonical status
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.partner_health_test_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    partner_id UUID NOT NULL REFERENCES public.partner_registry(id) ON DELETE CASCADE,
    partner_customer_link_id UUID REFERENCES public.partner_customer_links(id) ON DELETE SET NULL,
    product_order_id UUID REFERENCES public.product_orders(id) ON DELETE SET NULL,
    external_order_ref TEXT,
    external_sample_ref TEXT,
    test_sku TEXT,
    test_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN (
        'ordered', 'sample_kit_shipped', 'sample_received', 'processing',
        'result_ready', 'delivered', 'cancelled', 'failed', 'quarantined'
    )),
    status_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ordered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expected_result_at TIMESTAMPTZ,
    surfaced_at TIMESTAMPTZ, -- set once the ORB proactive provider has surfaced this result
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS partner_health_test_orders_user_idx ON public.partner_health_test_orders (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS partner_health_test_orders_status_idx ON public.partner_health_test_orders (status);
CREATE UNIQUE INDEX IF NOT EXISTS partner_health_test_orders_partner_ext_uidx
    ON public.partner_health_test_orders (partner_id, external_order_ref)
    WHERE external_order_ref IS NOT NULL;

COMMENT ON TABLE public.partner_health_test_orders IS 'VTID-03885: canonical Vitana-side status for a partner health test, independent of partner-specific terminology. AI/ORB reads ONLY this table''s status column, never a raw partner status string.';

-- ===========================================================================
-- 4. partner_health_test_status_history — append-only audit trail
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.partner_health_test_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.partner_health_test_orders(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    changed_by TEXT NOT NULL CHECK (changed_by IN ('partner_webhook', 'portal_admin', 'system')),
    source_ref TEXT,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS partner_health_test_status_history_order_idx ON public.partner_health_test_status_history (order_id, created_at);

COMMENT ON TABLE public.partner_health_test_status_history IS 'VTID-03885: append-only. Never mutate partner_health_test_orders.status without inserting a row here first.';

-- ===========================================================================
-- 5. partner_health_results — raw partner result + provenance
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.partner_health_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.partner_health_test_orders(id) ON DELETE CASCADE,
    partner_id UUID NOT NULL REFERENCES public.partner_registry(id) ON DELETE CASCADE,
    received_via TEXT NOT NULL CHECK (received_via IN ('webhook', 'portal_manual_upload')),
    raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    raw_file_ref TEXT,
    validation_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (validation_status IN ('pending', 'valid', 'invalid', 'quarantined')),
    validation_errors JSONB NOT NULL DEFAULT '[]'::JSONB,
    biomarker_result_ids UUID[] NOT NULL DEFAULT '{}',
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS partner_health_results_order_idx ON public.partner_health_results (order_id);

COMMENT ON TABLE public.partner_health_results IS 'VTID-03885: raw, partner-shaped result + full provenance. Validated rows get projected into biomarker_results/lab_reports by application code — this table is the source of truth for "where did this come from", not the display path.';

-- lab_reports gets one new nullable provenance link (no schema change to biomarker_results itself)
ALTER TABLE public.lab_reports ADD COLUMN IF NOT EXISTS partner_result_id UUID REFERENCES public.partner_health_results(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.lab_reports.partner_result_id IS 'VTID-03885: set when this lab_reports row was projected from a partner_health_results row rather than a direct user upload.';

-- ===========================================================================
-- 6. partner_health_result_inbox — quarantine queue
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.partner_health_result_inbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_id UUID NOT NULL REFERENCES public.partner_registry(id) ON DELETE CASCADE,
    raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    candidate_user_ids UUID[] NOT NULL DEFAULT '{}',
    reason TEXT NOT NULL CHECK (reason IN ('no_match', 'ambiguous_match', 'invalid_payload', 'consent_missing')),
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_by_admin_id UUID,
    resolved_order_id UUID REFERENCES public.partner_health_test_orders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS partner_health_result_inbox_unresolved_idx ON public.partner_health_result_inbox (resolved, created_at) WHERE resolved = FALSE;

COMMENT ON TABLE public.partner_health_result_inbox IS 'VTID-03885: quarantine for any inbound result that could not be safely auto-processed. A wrong health-result/user match is a critical safety issue — rows here are only ever resolved by an explicit admin action, never guessed.';

-- ===========================================================================
-- 7. data_sharing_consents — platform-wide consent primitive (first real
--    consumer: partner health-test integrations; designed to generalize)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.data_sharing_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    resource_type TEXT NOT NULL, -- e.g. 'partner_integration' — free-text by convention, not a CHECK, so future features can add values without a migration
    resource_id TEXT NOT NULL,  -- e.g. a partner_key
    scope TEXT NOT NULL,        -- e.g. 'order_tracking' | 'result_ingestion'
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,     -- NULL = active
    granted_via TEXT NOT NULL CHECK (granted_via IN ('checkout_flow', 'settings_connected_apps', 'portal_admin_backfill')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS data_sharing_consents_uidx
    ON public.data_sharing_consents (tenant_id, user_id, resource_type, resource_id, scope);
CREATE INDEX IF NOT EXISTS data_sharing_consents_active_idx
    ON public.data_sharing_consents (tenant_id, user_id, resource_type, resource_id, scope) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.data_sharing_consents IS 'VTID-03885: platform-wide data-sharing consent primitive (generalizes the append-only pattern already proven by ai_consent_log). Revocation is future-ingestion-only by design — it does not retroactively purge already-ingested data.';

-- ===========================================================================
-- 8. data_sharing_consent_events — append-only audit log (companion to #7)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.data_sharing_consent_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
    actor_role TEXT,
    actor_id UUID,
    before JSONB,
    after JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS data_sharing_consent_events_user_idx ON public.data_sharing_consent_events (tenant_id, user_id, created_at);

COMMENT ON TABLE public.data_sharing_consent_events IS 'VTID-03885: append-only audit trail for data_sharing_consents. This is what a future "Sharing Logs" UI would read from — not built by this migration, but not precluded by it.';

-- ===========================================================================
-- 9. Seed partner_registry with DoctorBox (Partner #001)
-- ===========================================================================

INSERT INTO public.partner_registry (partner_key, display_name, integration_mode, status, capabilities)
VALUES (
    'doctorbox',
    'DoctorBox',
    'portal_manual',
    'sandbox',
    '{"has_order_api": false, "has_webhook": false, "has_result_api": false}'::JSONB
)
ON CONFLICT (partner_key) DO NOTHING;

-- ===========================================================================
-- 10. RLS — enable everywhere; only genuinely user-owned tables get a
--     read policy for the authenticated client. All writes in this feature
--     happen via the gateway's service-role client (which bypasses RLS by
--     design, per platform convention) — these policies are defense-in-depth
--     for any future direct-client read, not the primary access-control path.
-- ===========================================================================

ALTER TABLE public.partner_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_customer_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_health_test_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_health_test_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_health_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_health_result_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_sharing_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_sharing_consent_events ENABLE ROW LEVEL SECURITY;

-- partner_registry: non-sensitive reference/catalog data, readable by any authenticated user (like `merchants`).
DROP POLICY IF EXISTS partner_registry_select ON public.partner_registry;
CREATE POLICY partner_registry_select ON public.partner_registry
    FOR SELECT TO authenticated USING (true);

-- partner_health_test_orders: user reads only their own rows.
DROP POLICY IF EXISTS partner_health_test_orders_select ON public.partner_health_test_orders;
CREATE POLICY partner_health_test_orders_select ON public.partner_health_test_orders
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

-- partner_health_test_status_history: user reads history for their own orders only.
DROP POLICY IF EXISTS partner_health_test_status_history_select ON public.partner_health_test_status_history;
CREATE POLICY partner_health_test_status_history_select ON public.partner_health_test_status_history
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.partner_health_test_orders o
            WHERE o.id = partner_health_test_status_history.order_id
              AND o.tenant_id = public.current_tenant_id()
              AND o.user_id = public.current_user_id()
        )
    );

-- partner_health_results: user reads results for their own orders only.
DROP POLICY IF EXISTS partner_health_results_select ON public.partner_health_results;
CREATE POLICY partner_health_results_select ON public.partner_health_results
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.partner_health_test_orders o
            WHERE o.id = partner_health_results.order_id
              AND o.tenant_id = public.current_tenant_id()
              AND o.user_id = public.current_user_id()
        )
    );

-- data_sharing_consents: user reads/manages their own consent rows.
DROP POLICY IF EXISTS data_sharing_consents_select ON public.data_sharing_consents;
CREATE POLICY data_sharing_consents_select ON public.data_sharing_consents
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

-- data_sharing_consent_events: user reads their own audit trail.
DROP POLICY IF EXISTS data_sharing_consent_events_select ON public.data_sharing_consent_events;
CREATE POLICY data_sharing_consent_events_select ON public.data_sharing_consent_events
    FOR SELECT USING (
        tenant_id = public.current_tenant_id()
        AND user_id = public.current_user_id()
    );

-- partner_customer_links, partner_health_result_inbox: internal/admin only.
-- RLS enabled above with NO policies at all — service-role only, same
-- pattern as community_marketplace_seller_suspensions (VTID-BOOTSTRAP-
-- COMMUNITY-MARKETPLACE Chunk 7).
