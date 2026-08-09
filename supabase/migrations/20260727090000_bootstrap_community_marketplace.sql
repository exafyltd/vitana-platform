-- BOOTSTRAP-COMMUNITY-MARKETPLACE
-- Peer-to-peer classifieds: community members list products (new/used) or
-- services they offer. Contact-only in v1 (no Vitana checkout/payments/
-- commissions) — buyer and seller message each other via the existing
-- chat_messages system and arrange payment/delivery themselves.
--
-- Distinct from the VTID-02000 merchants/products catalog (20260416120000):
-- that model is a global, scraped/affiliate catalog with one canonical
-- merchant per row. This feature needs one row per individual seller-user,
-- so it gets its own tables rather than reusing merchants/products.
--
-- No formal VTID exists yet for this feature — tracked under this BOOTSTRAP
-- tag pending one, same convention as BOOTSTRAP-FEATURE-ANNOUNCEMENTS,
-- BOOTSTRAP-DAILY-FEATURE-TIP, BOOTSTRAP-PUBLIC-BUSINESS-PROFILE.
--
-- Decided defaults (see plan for full rationale):
--   - Verification-gated categories check profiles.verification_status
--     only; no request/approval workflow is built here.
--   - Health/supplement/medical categories are out of scope for this
--     taxonomy entirely (the existing curated products catalog covers that
--     domain) — no such categories are seeded below.
--   - "Block seller" is scoped to this feature (marketplace visibility
--     only), not a platform-wide user block.
--   - merchant_id/fulfillment_mode are extension seams for a future
--     verified-partner-checkout story; unused (NULL/'contact_only') in v1.

BEGIN;

-- ===========================================================================
-- 1. community_listing_categories — admin-editable taxonomy lookup
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.community_listing_categories (
  key                          TEXT PRIMARY KEY,
  listing_kind                 TEXT NOT NULL CHECK (listing_kind IN ('product', 'service', 'both')),
  display_label                TEXT NOT NULL,
  parent_key                   TEXT REFERENCES public.community_listing_categories(key) ON DELETE SET NULL,
  is_prohibited                BOOLEAN NOT NULL DEFAULT FALSE,
  requires_verified_provider   BOOLEAN NOT NULL DEFAULT FALSE,
  requires_admin_review_always BOOLEAN NOT NULL DEFAULT FALSE,
  is_active                    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order                   INT NOT NULL DEFAULT 0,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.community_listing_categories IS
  'BOOTSTRAP-COMMUNITY-MARKETPLACE: admin-editable category taxonomy for peer-to-peer listings. is_prohibited/requires_verified_provider drive listing-moderation-check.ts. Seed content (which categories exist, which are prohibited/verification-gated) requires explicit product/trust-and-safety sign-off — not fully seeded by this migration.';

-- ===========================================================================
-- 2. community_listings — core table
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.community_listings (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  seller_user_id         UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,

  listing_kind           TEXT NOT NULL CHECK (listing_kind IN ('product', 'service')),
  condition              TEXT CHECK (condition IS NULL OR condition IN ('new', 'like_new', 'good', 'fair', 'used')),

  category               TEXT NOT NULL,
  subcategory            TEXT,
  title                  TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description            TEXT NOT NULL CHECK (char_length(description) BETWEEN 10 AND 4000),
  images                 TEXT[] NOT NULL DEFAULT '{}',

  price_cents            INT CHECK (price_cents IS NULL OR price_cents >= 0),
  currency               CHAR(3),
  price_on_request       BOOLEAN NOT NULL DEFAULT FALSE,

  location_text          TEXT,
  is_remote_service       BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_method         TEXT NOT NULL DEFAULT 'not_applicable'
                           CHECK (delivery_method IN ('pickup', 'shipping', 'both', 'not_applicable')),

  -- Extensibility seam for future verified-partner checkout — unused in v1
  fulfillment_mode        TEXT NOT NULL DEFAULT 'contact_only'
                           CHECK (fulfillment_mode IN ('contact_only', 'vitana_checkout')),
  merchant_id             UUID REFERENCES public.merchants(id) ON DELETE SET NULL,

  requires_verified_provider BOOLEAN NOT NULL DEFAULT FALSE,

  status                  TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('draft', 'active', 'paused', 'sold', 'removed', 'suspended')),
  sold_at                 TIMESTAMPTZ,
  renewed_at              TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),

  auto_check_result       TEXT NOT NULL DEFAULT 'pending'
                           CHECK (auto_check_result IN ('pending', 'passed', 'flagged', 'blocked')),
  auto_check_reasons      TEXT[] NOT NULL DEFAULT '{}',

  requires_admin_review   BOOLEAN NOT NULL DEFAULT FALSE,
  admin_review_reason     TEXT,
  admin_notes              TEXT,
  reviewed_by              UUID,
  reviewed_at              TIMESTAMPTZ,

  view_count               INT NOT NULL DEFAULT 0,
  contact_click_count      INT NOT NULL DEFAULT 0,

  search_text TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(category, '') || ' ' || COALESCE(subcategory, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(description, '')), 'C')
  ) STORED,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT community_listings_price_or_on_request CHECK (
    price_on_request = TRUE OR (price_cents IS NOT NULL AND currency IS NOT NULL)
  ),
  CONSTRAINT community_listings_images_max CHECK (
    images IS NULL OR array_length(images, 1) IS NULL OR array_length(images, 1) <= 10
  )
);

COMMENT ON COLUMN public.community_listings.merchant_id IS
  'Extension seam for a future verified-partner-checkout story: set this + flip fulfillment_mode to vitana_checkout to graduate a listing off contact-only. NULL for every v1 row.';
COMMENT ON COLUMN public.community_listings.requires_verified_provider IS
  'Set by listing-moderation-check.ts when the category requires a verified provider. Gated on profiles.verification_status only — no request/approval workflow exists yet.';

CREATE INDEX IF NOT EXISTS idx_community_listings_seller ON public.community_listings (seller_user_id, status);
CREATE INDEX IF NOT EXISTS idx_community_listings_tenant_status ON public.community_listings (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_listings_category ON public.community_listings (category, subcategory, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_community_listings_search ON public.community_listings USING GIN (search_text);
CREATE INDEX IF NOT EXISTS idx_community_listings_review_queue ON public.community_listings (tenant_id, requires_admin_review) WHERE requires_admin_review = TRUE;
CREATE INDEX IF NOT EXISTS idx_community_listings_expiring ON public.community_listings (expires_at) WHERE status = 'active';

CREATE OR REPLACE FUNCTION public.community_listings_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_community_listings_updated_at ON public.community_listings;
CREATE TRIGGER trg_community_listings_updated_at
  BEFORE UPDATE ON public.community_listings
  FOR EACH ROW EXECUTE FUNCTION public.community_listings_set_updated_at();

-- ===========================================================================
-- 3. community_listing_reports — user Report/Flag submissions
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.community_listing_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id        UUID NOT NULL REFERENCES public.community_listings(id) ON DELETE CASCADE,
  reporter_user_id  UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,

  report_reason     TEXT NOT NULL CHECK (report_reason IN
                       ('prohibited_item', 'misleading', 'counterfeit', 'spam', 'offensive', 'scam', 'other')),
  report_note       TEXT,

  status            TEXT NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received', 'under_review', 'actioned', 'dismissed')),
  admin_notes       TEXT,
  resolved_by       UUID,
  resolved_at       TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (listing_id, reporter_user_id)
);

CREATE INDEX IF NOT EXISTS idx_clr_listing ON public.community_listing_reports (listing_id, status);
CREATE INDEX IF NOT EXISTS idx_clr_pending ON public.community_listing_reports (tenant_id, status, created_at) WHERE status = 'received';

-- ===========================================================================
-- 4. community_listing_seller_blocks — per-viewer seller block (marketplace-scoped)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.community_listing_seller_blocks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_user_id      UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  blocked_seller_id   UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL REFERENCES public.tenants(tenant_id) ON DELETE CASCADE,
  reason              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (viewer_user_id, blocked_seller_id),
  CONSTRAINT community_listing_seller_blocks_no_self_block CHECK (viewer_user_id <> blocked_seller_id)
);

CREATE INDEX IF NOT EXISTS idx_clsb_viewer ON public.community_listing_seller_blocks (viewer_user_id);

COMMENT ON TABLE public.community_listing_seller_blocks IS
  'BOOTSTRAP-COMMUNITY-MARKETPLACE: scoped to hiding a seller''s listings from a viewer in marketplace browse/search only. Not a platform-wide user block (DMs/feed unaffected).';

-- ===========================================================================
-- 5. listing_status_history — immutable audit trail
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.listing_status_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id    UUID NOT NULL REFERENCES public.community_listings(id) ON DELETE CASCADE,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('seller', 'admin', 'system')),
  actor_user_id UUID,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  reason        TEXT,
  snapshot      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lsh_listing ON public.listing_status_history (listing_id, created_at DESC);

-- ===========================================================================
-- 6. RLS
-- ===========================================================================

ALTER TABLE public.community_listing_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clc_select ON public.community_listing_categories;
CREATE POLICY clc_select ON public.community_listing_categories FOR SELECT TO authenticated USING (is_active = TRUE);
DROP POLICY IF EXISTS clc_service ON public.community_listing_categories;
CREATE POLICY clc_service ON public.community_listing_categories FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.community_listings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS community_listings_select_public ON public.community_listings;
CREATE POLICY community_listings_select_public ON public.community_listings
  FOR SELECT TO authenticated
  USING (status IN ('active', 'paused', 'sold') AND tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS community_listings_select_own ON public.community_listings;
CREATE POLICY community_listings_select_own ON public.community_listings
  FOR SELECT TO authenticated USING (seller_user_id = auth.uid());

DROP POLICY IF EXISTS community_listings_insert_own ON public.community_listings;
CREATE POLICY community_listings_insert_own ON public.community_listings
  FOR INSERT TO authenticated WITH CHECK (seller_user_id = auth.uid());

DROP POLICY IF EXISTS community_listings_update_own ON public.community_listings;
CREATE POLICY community_listings_update_own ON public.community_listings
  FOR UPDATE TO authenticated USING (seller_user_id = auth.uid()) WITH CHECK (seller_user_id = auth.uid());

DROP POLICY IF EXISTS community_listings_service ON public.community_listings;
CREATE POLICY community_listings_service ON public.community_listings FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.community_listing_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clr_insert_own ON public.community_listing_reports;
CREATE POLICY clr_insert_own ON public.community_listing_reports
  FOR INSERT TO authenticated WITH CHECK (reporter_user_id = auth.uid());
DROP POLICY IF EXISTS clr_select_own ON public.community_listing_reports;
CREATE POLICY clr_select_own ON public.community_listing_reports
  FOR SELECT TO authenticated USING (reporter_user_id = auth.uid());
DROP POLICY IF EXISTS clr_service ON public.community_listing_reports;
CREATE POLICY clr_service ON public.community_listing_reports FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.community_listing_seller_blocks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clsb_own ON public.community_listing_seller_blocks;
CREATE POLICY clsb_own ON public.community_listing_seller_blocks
  FOR ALL TO authenticated USING (viewer_user_id = auth.uid()) WITH CHECK (viewer_user_id = auth.uid());
DROP POLICY IF EXISTS clsb_service ON public.community_listing_seller_blocks;
CREATE POLICY clsb_service ON public.community_listing_seller_blocks FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.listing_status_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lsh_service ON public.listing_status_history;
CREATE POLICY lsh_service ON public.listing_status_history FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ===========================================================================
-- 7. Seed a minimal, deliberately small starter taxonomy
-- ===========================================================================
-- Kept intentionally small and generic (no health/supplement/medical
-- categories per the decided v1 scope). This is a starter set so the
-- feature is usable end-to-end; the real, complete category list and
-- prohibited/verification-gated flags still need product/trust-and-safety
-- sign-off before broader rollout — admins can add/edit rows via
-- GET/PATCH /api/v1/admin/community-marketplace/categories without a
-- migration.

INSERT INTO public.community_listing_categories (key, listing_kind, display_label, is_prohibited, requires_verified_provider, requires_admin_review_always, sort_order)
VALUES
  ('electronics',        'product', 'Electronics',            FALSE, FALSE, FALSE, 10),
  ('home_furniture',     'product', 'Home & Furniture',       FALSE, FALSE, FALSE, 20),
  ('fashion_apparel',    'product', 'Fashion & Apparel',      FALSE, FALSE, FALSE, 30),
  ('books_media',        'product', 'Books & Media',          FALSE, FALSE, FALSE, 40),
  ('sports_outdoors',    'product', 'Sports & Outdoors',      FALSE, FALSE, FALSE, 50),
  ('kids_baby',          'product', 'Kids & Baby',            FALSE, FALSE, FALSE, 60),
  ('other_items',        'product', 'Other Items',            FALSE, FALSE, FALSE, 70),
  ('home_services',      'service', 'Home Services',          FALSE, FALSE, FALSE, 100),
  ('tutoring_coaching',  'service', 'Tutoring & Coaching',     FALSE, FALSE, FALSE, 110),
  ('creative_freelance',  'service', 'Creative & Freelance',   FALSE, FALSE, FALSE, 120),
  ('events_services',     'service', 'Events & Occasions',    FALSE, FALSE, FALSE, 130),
  ('other_services',      'service', 'Other Services',        FALSE, FALSE, FALSE, 140)
ON CONFLICT (key) DO NOTHING;

COMMIT;
