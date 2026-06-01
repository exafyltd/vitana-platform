-- VTID-03237 — Video Shop (Vitanaland TikTok-style commerce), backend slice.
--
-- impact-allow-solo-migration
-- Intentional solo migration: the consuming gateway code (shop-feed routes +
-- universal-cart attribution) ships in the paired gateway PR #2470, split out so
-- each PR stays single-domain for the VALIDATOR-CHECK path-ownership gate. The new
-- tables/columns are additive and inert until that code lands.
--
-- A NEW SURFACE over the EXISTING commerce graph — not a second commerce system.
-- It reuses the Discover `products` catalog (VTID-02000), the Universal Cart
-- (VTID-03186 / VTID-03213) for staging + attribution, and the EUR/USD wallet
-- (VTID-03200) later. This migration adds ONLY a presentation + binding +
-- analytics layer plus an attribution thread; it forks nothing.
--
-- Introduces four tables:
--   * public.shop_videos          — curated vertical short clips (admin-seeded in V1).
--   * public.shop_video_anchors   — binds ONE primary product per video (the pill).
--   * public.shop_saved_products  — drawer "Save" / wishlist, with video attribution.
--   * public.shop_video_events    — funnel analytics sink. DELIBERATELY NOT oasis_events:
--                                   oasis_events is the VTID governance/lifecycle bus
--                                   (CLAUDE.md §6 — "telemetry.* NEVER to OASIS").
--                                   Video view-funnel telemetry lands here instead.
--
-- Plus an additive attribution thread (all nullable → non-breaking):
--   * universal_cart_items.source_video_id / source_creator_id
--   * product_orders.source_video_id / source_creator_id   (snapshot for future V1.2 payout)
--   * 'video_shop' added to the universal_cart_items.source_surface CHECK.
--
-- V1 launch shape (per product guidance): curated videos, approved products,
-- single anchor, drawer, add-to-cart (Universal Cart), save, share, PDP, clean
-- attribution. NO wallet "buy now" (no checkout bridge exists yet), NO open
-- seller upload, NO affiliate payout math, NO live shopping. Those are V1.1–V1.3.
--
-- All changes are additive (new tables + nullable columns + one widened CHECK)
-- → safe online migration, no backfill required.

BEGIN;

-- ============================================================
-- Pre-condition: schema-drift guard (TARGET TABLES ONLY).
-- RAISEs only when one of the four new TARGET tables already exists with
-- columns outside the expected set (mirrors the VTID-03186 pattern). The
-- existing universal_cart_items / product_orders tables are NOT in this guard;
-- we only ADD COLUMN IF NOT EXISTS to them below.
-- ============================================================
DO $vtid_03237_pre_guard$
DECLARE
  unexpected TEXT;
BEGIN
  SELECT string_agg(c.table_name || '.' || c.column_name, ', ' ORDER BY c.table_name, c.column_name)
    INTO unexpected
    FROM information_schema.columns c
    LEFT JOIN (VALUES
      ('shop_videos','id'),('shop_videos','creator_id'),('shop_videos','tenant_id'),
      ('shop_videos','title'),('shop_videos','caption'),('shop_videos','video_url'),
      ('shop_videos','poster_url'),('shop_videos','thumbnail_url'),('shop_videos','duration_ms'),
      ('shop_videos','aspect_ratio'),('shop_videos','status'),('shop_videos','moderation_status'),
      ('shop_videos','is_curated'),('shop_videos','rank_score'),('shop_videos','metadata'),
      ('shop_videos','created_at'),('shop_videos','updated_at'),
      ('shop_video_anchors','id'),('shop_video_anchors','video_id'),('shop_video_anchors','product_id'),
      ('shop_video_anchors','is_primary'),('shop_video_anchors','label'),('shop_video_anchors','badge_price_cents'),
      ('shop_video_anchors','currency'),('shop_video_anchors','appear_at_ms'),('shop_video_anchors','pos_x'),
      ('shop_video_anchors','pos_y'),('shop_video_anchors','metadata'),
      ('shop_video_anchors','created_at'),('shop_video_anchors','updated_at'),
      ('shop_saved_products','id'),('shop_saved_products','user_id'),('shop_saved_products','product_id'),
      ('shop_saved_products','video_id'),('shop_saved_products','created_at'),
      ('shop_video_events','id'),('shop_video_events','video_id'),('shop_video_events','anchor_id'),
      ('shop_video_events','user_id'),('shop_video_events','session_id'),('shop_video_events','event_type'),
      ('shop_video_events','product_id'),('shop_video_events','dwell_ms'),('shop_video_events','metadata'),
      ('shop_video_events','created_at')
    ) AS allowed(tbl, col)
      ON allowed.tbl = c.table_name AND allowed.col = c.column_name
   WHERE c.table_schema = 'public'
     AND c.table_name IN ('shop_videos','shop_video_anchors','shop_saved_products','shop_video_events')
     AND allowed.tbl IS NULL;

  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION
      'VTID-03237 pre-condition: unexpected columns on TARGET tables (shop_videos / shop_video_anchors / shop_saved_products / shop_video_events): %. Investigate ad-hoc DB state before re-running.',
      unexpected;
  END IF;
END
$vtid_03237_pre_guard$;

-- ============================================================
-- shop_videos — curated vertical short clip
-- ============================================================
CREATE TABLE IF NOT EXISTS public.shop_videos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id        UUID REFERENCES public.app_users(user_id) ON DELETE SET NULL,
  tenant_id         UUID,
  title             TEXT,
  caption           TEXT,
  video_url         TEXT NOT NULL,
  poster_url        TEXT,
  thumbnail_url     TEXT,
  duration_ms       INT NOT NULL DEFAULT 0,
  aspect_ratio      TEXT NOT NULL DEFAULT '9:16',
  status            TEXT NOT NULL DEFAULT 'draft',
  moderation_status TEXT NOT NULL DEFAULT 'pending',
  is_curated        BOOLEAN NOT NULL DEFAULT TRUE,
  rank_score        NUMERIC NOT NULL DEFAULT 0,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS creator_id        UUID;
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS tenant_id         UUID;
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS title             TEXT;
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS caption           TEXT;
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS video_url         TEXT;
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS poster_url        TEXT;
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS thumbnail_url     TEXT;
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS duration_ms       INT NOT NULL DEFAULT 0;
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS aspect_ratio      TEXT NOT NULL DEFAULT '9:16';
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS is_curated        BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS rank_score        NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS metadata          JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.shop_videos ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.shop_videos DROP CONSTRAINT IF EXISTS shop_videos_status_check;
ALTER TABLE public.shop_videos ADD  CONSTRAINT shop_videos_status_check
  CHECK (status IN ('draft','processing','active','paused','removed'));
ALTER TABLE public.shop_videos DROP CONSTRAINT IF EXISTS shop_videos_moderation_check;
ALTER TABLE public.shop_videos ADD  CONSTRAINT shop_videos_moderation_check
  CHECK (moderation_status IN ('pending','approved','rejected'));

COMMENT ON TABLE public.shop_videos IS
  'VTID-03237: curated vertical short clips that back the Video Shop feed. V1 = admin-seeded (is_curated=true); open seller upload is V1.1. A video is feed-eligible only when status=active AND moderation_status=approved AND it has a primary anchor whose product is active/in_stock.';

CREATE INDEX IF NOT EXISTS shop_videos_feed_idx
  ON public.shop_videos (status, moderation_status, rank_score DESC);
CREATE INDEX IF NOT EXISTS shop_videos_creator_idx
  ON public.shop_videos (creator_id);
CREATE INDEX IF NOT EXISTS shop_videos_tenant_idx
  ON public.shop_videos (tenant_id) WHERE tenant_id IS NOT NULL;

-- ============================================================
-- shop_video_anchors — binds a product to a video (one primary per video)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.shop_video_anchors (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id         UUID NOT NULL REFERENCES public.shop_videos(id) ON DELETE CASCADE,
  product_id       UUID NOT NULL REFERENCES public.products(id),
  is_primary       BOOLEAN NOT NULL DEFAULT TRUE,
  label            TEXT NOT NULL DEFAULT 'Shop now',
  badge_price_cents INT,
  currency         CHAR(3),
  appear_at_ms     INT NOT NULL DEFAULT 0,
  pos_x            NUMERIC NOT NULL DEFAULT 0.5,
  pos_y            NUMERIC NOT NULL DEFAULT 0.82,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.shop_video_anchors ADD COLUMN IF NOT EXISTS video_id          UUID;
ALTER TABLE public.shop_video_anchors ADD COLUMN IF NOT EXISTS product_id        UUID;
ALTER TABLE public.shop_video_anchors ADD COLUMN IF NOT EXISTS is_primary        BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.shop_video_anchors ADD COLUMN IF NOT EXISTS label             TEXT NOT NULL DEFAULT 'Shop now';
ALTER TABLE public.shop_video_anchors ADD COLUMN IF NOT EXISTS badge_price_cents INT;
ALTER TABLE public.shop_video_anchors ADD COLUMN IF NOT EXISTS currency          CHAR(3);
ALTER TABLE public.shop_video_anchors ADD COLUMN IF NOT EXISTS appear_at_ms      INT NOT NULL DEFAULT 0;
ALTER TABLE public.shop_video_anchors ADD COLUMN IF NOT EXISTS pos_x             NUMERIC NOT NULL DEFAULT 0.5;
ALTER TABLE public.shop_video_anchors ADD COLUMN IF NOT EXISTS pos_y             NUMERIC NOT NULL DEFAULT 0.82;
ALTER TABLE public.shop_video_anchors ADD COLUMN IF NOT EXISTS metadata          JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.shop_video_anchors ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.shop_video_anchors ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON TABLE public.shop_video_anchors IS
  'VTID-03237: binds a products row to a shop_video. V1 ships a single PRIMARY anchor per video (the tappable pill). Single-primary invariant is enforced by the partial unique index below AND transactionally in the gateway studio slice (V1.1).';
COMMENT ON COLUMN public.shop_video_anchors.badge_price_cents IS
  'Optional price snapshot for the pill (cents, matching products.price_cents). Display-only; the cart re-reads live product price at add-time.';

-- Single-primary invariant: at most one is_primary=true anchor per video.
CREATE UNIQUE INDEX IF NOT EXISTS shop_video_anchors_one_primary
  ON public.shop_video_anchors (video_id) WHERE is_primary = TRUE;
CREATE INDEX IF NOT EXISTS shop_video_anchors_video_idx
  ON public.shop_video_anchors (video_id);
CREATE INDEX IF NOT EXISTS shop_video_anchors_product_idx
  ON public.shop_video_anchors (product_id);

-- ============================================================
-- shop_saved_products — drawer "Save" / wishlist
-- ============================================================
CREATE TABLE IF NOT EXISTS public.shop_saved_products (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id),
  video_id   UUID REFERENCES public.shop_videos(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.shop_saved_products ADD COLUMN IF NOT EXISTS user_id    UUID;
ALTER TABLE public.shop_saved_products ADD COLUMN IF NOT EXISTS product_id UUID;
ALTER TABLE public.shop_saved_products ADD COLUMN IF NOT EXISTS video_id   UUID;
ALTER TABLE public.shop_saved_products ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.shop_saved_products DROP CONSTRAINT IF EXISTS shop_saved_products_user_product_uniq;
ALTER TABLE public.shop_saved_products ADD  CONSTRAINT shop_saved_products_user_product_uniq
  UNIQUE (user_id, product_id);

COMMENT ON TABLE public.shop_saved_products IS
  'VTID-03237: per-user product saves (wishlist) from the Video Shop drawer. video_id records the source video for attribution; nulled if the video is later removed.';

CREATE INDEX IF NOT EXISTS shop_saved_products_user_idx
  ON public.shop_saved_products (user_id, created_at DESC);

-- ============================================================
-- shop_video_events — funnel analytics sink (NOT oasis_events)
-- High-cardinality view/commerce funnel. Written by the gateway via
-- service_role. Repointable to ClickHouse/BigQuery later without changing
-- the API contract.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.shop_video_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  video_id    UUID NOT NULL REFERENCES public.shop_videos(id) ON DELETE CASCADE,
  anchor_id   UUID,
  user_id     UUID,
  session_id  TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  product_id  UUID REFERENCES public.products(id) ON DELETE SET NULL,
  dwell_ms    INT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.shop_video_events ADD COLUMN IF NOT EXISTS anchor_id  UUID;
ALTER TABLE public.shop_video_events ADD COLUMN IF NOT EXISTS user_id    UUID;
ALTER TABLE public.shop_video_events ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE public.shop_video_events ADD COLUMN IF NOT EXISTS event_type TEXT;
ALTER TABLE public.shop_video_events ADD COLUMN IF NOT EXISTS product_id UUID;
ALTER TABLE public.shop_video_events ADD COLUMN IF NOT EXISTS dwell_ms   INT;
ALTER TABLE public.shop_video_events ADD COLUMN IF NOT EXISTS metadata   JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.shop_video_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.shop_video_events DROP CONSTRAINT IF EXISTS shop_video_events_type_check;
ALTER TABLE public.shop_video_events ADD  CONSTRAINT shop_video_events_type_check
  CHECK (event_type IN (
    'impression','hold_2s','anchor_tap','drawer_open','drawer_expand','pdp_view',
    'variant_change','add_to_cart','buy_now','checkout_start','purchase',
    'save','unsave','share','drawer_close'
  ));

COMMENT ON TABLE public.shop_video_events IS
  'VTID-03237: Video Shop view/commerce funnel sink. DELIBERATELY SEPARATE from oasis_events (CLAUDE.md §6: telemetry.* never to OASIS). Written by the gateway shop-feed route via service_role. Feeds rank_score recompute later.';

CREATE INDEX IF NOT EXISTS shop_video_events_video_type_idx
  ON public.shop_video_events (video_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS shop_video_events_session_idx
  ON public.shop_video_events (session_id, created_at);
CREATE INDEX IF NOT EXISTS shop_video_events_created_idx
  ON public.shop_video_events (created_at);

-- ============================================================
-- Attribution thread (additive, nullable → non-breaking).
-- ============================================================
ALTER TABLE public.universal_cart_items
  ADD COLUMN IF NOT EXISTS source_video_id   UUID REFERENCES public.shop_videos(id) ON DELETE SET NULL;
ALTER TABLE public.universal_cart_items
  ADD COLUMN IF NOT EXISTS source_creator_id UUID REFERENCES public.app_users(user_id) ON DELETE SET NULL;

COMMENT ON COLUMN public.universal_cart_items.source_video_id IS
  'VTID-03237: video the add was attributed to when source_surface=video_shop. Structured companion to source_ref.';
COMMENT ON COLUMN public.universal_cart_items.source_creator_id IS
  'VTID-03237: creator credited for the add (foundation for V1.2 affiliate payout). app_users.user_id.';

CREATE INDEX IF NOT EXISTS universal_cart_items_source_video_idx
  ON public.universal_cart_items (source_video_id) WHERE source_video_id IS NOT NULL;

ALTER TABLE public.product_orders
  ADD COLUMN IF NOT EXISTS source_video_id   UUID REFERENCES public.shop_videos(id) ON DELETE SET NULL;
ALTER TABLE public.product_orders
  ADD COLUMN IF NOT EXISTS source_creator_id UUID REFERENCES public.app_users(user_id) ON DELETE SET NULL;

COMMENT ON COLUMN public.product_orders.source_video_id IS
  'VTID-03237: attribution snapshot — video that drove the conversion. Copied from universal_cart_items at order time (wired in the future checkout bridge). Nullable; affiliate-postback orders leave it NULL.';
COMMENT ON COLUMN public.product_orders.source_creator_id IS
  'VTID-03237: attribution snapshot — creator credited for the conversion. Basis for V1.2 commission math.';

CREATE INDEX IF NOT EXISTS product_orders_source_creator_idx
  ON public.product_orders (source_creator_id) WHERE source_creator_id IS NOT NULL;

-- Widen the universal_cart_items.source_surface CHECK to admit 'video_shop'.
-- Keep in sync with ALLOWED_SOURCE_SURFACES in
-- services/gateway/src/routes/universal-cart.ts.
ALTER TABLE public.universal_cart_items
  DROP CONSTRAINT IF EXISTS universal_cart_items_source_surface_check;
ALTER TABLE public.universal_cart_items
  ADD  CONSTRAINT universal_cart_items_source_surface_check
  CHECK (source_surface IS NULL OR source_surface IN
    ('web','mobile','voice','autopilot','community','video_shop'));

-- ============================================================
-- Explicit table grants (defense-in-depth alongside RLS).
-- Feed/anchor are world-readable to authenticated (the feed is browsable);
-- saves are owner-scoped; events + videos/anchors are written by service_role
-- (curated seeding + funnel ingestion) only.
-- ============================================================
GRANT SELECT                          ON public.shop_videos         TO authenticated;
GRANT SELECT                          ON public.shop_video_anchors  TO authenticated;
GRANT SELECT, INSERT, DELETE          ON public.shop_saved_products TO authenticated;
GRANT ALL                             ON public.shop_videos         TO service_role;
GRANT ALL                             ON public.shop_video_anchors  TO service_role;
GRANT ALL                             ON public.shop_saved_products TO service_role;
GRANT ALL                             ON public.shop_video_events   TO service_role;

-- ============================================================
-- updated_at triggers (reuse the VTID-03186 generic touch function).
-- ============================================================
DROP TRIGGER IF EXISTS shop_videos_updated_at_trigger ON public.shop_videos;
CREATE TRIGGER shop_videos_updated_at_trigger
  BEFORE UPDATE ON public.shop_videos
  FOR EACH ROW EXECUTE FUNCTION public.universal_cart_touch_updated_at();

DROP TRIGGER IF EXISTS shop_video_anchors_updated_at_trigger ON public.shop_video_anchors;
CREATE TRIGGER shop_video_anchors_updated_at_trigger
  BEFORE UPDATE ON public.shop_video_anchors
  FOR EACH ROW EXECUTE FUNCTION public.universal_cart_touch_updated_at();

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.shop_videos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_video_anchors  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_saved_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_video_events   ENABLE ROW LEVEL SECURITY;

-- shop_videos: authenticated can read live (active + approved) videos only.
-- Drafts / pending / rejected are visible to service_role (gateway) only.
DROP POLICY IF EXISTS shop_videos_select_live ON public.shop_videos;
CREATE POLICY shop_videos_select_live ON public.shop_videos
  FOR SELECT TO authenticated
  USING (status = 'active' AND moderation_status = 'approved');

-- shop_video_anchors: readable when the parent video is live.
DROP POLICY IF EXISTS shop_video_anchors_select_via_video ON public.shop_video_anchors;
CREATE POLICY shop_video_anchors_select_via_video ON public.shop_video_anchors
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.shop_videos v
                  WHERE v.id = shop_video_anchors.video_id
                    AND v.status = 'active' AND v.moderation_status = 'approved'));

-- shop_saved_products: owner-only full access.
DROP POLICY IF EXISTS shop_saved_products_select_own ON public.shop_saved_products;
CREATE POLICY shop_saved_products_select_own ON public.shop_saved_products
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS shop_saved_products_insert_own ON public.shop_saved_products;
CREATE POLICY shop_saved_products_insert_own ON public.shop_saved_products
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS shop_saved_products_delete_own ON public.shop_saved_products;
CREATE POLICY shop_saved_products_delete_own ON public.shop_saved_products
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- shop_video_events: no authenticated access. service_role bypasses RLS and is
-- the only reader/writer (funnel ingestion + analytics). Enabling RLS with no
-- policy denies `authenticated` by default.

-- ============================================================
-- Post-condition: required-column guard
-- ============================================================
DO $vtid_03237_post_guard$
DECLARE
  expected_columns CONSTANT TEXT[] := ARRAY[
    'shop_videos.id','shop_videos.video_url','shop_videos.status','shop_videos.moderation_status','shop_videos.rank_score',
    'shop_video_anchors.id','shop_video_anchors.video_id','shop_video_anchors.product_id','shop_video_anchors.is_primary',
    'shop_saved_products.id','shop_saved_products.user_id','shop_saved_products.product_id',
    'shop_video_events.id','shop_video_events.video_id','shop_video_events.session_id','shop_video_events.event_type',
    'universal_cart_items.source_video_id','universal_cart_items.source_creator_id',
    'product_orders.source_video_id','product_orders.source_creator_id'
  ];
  missing TEXT;
BEGIN
  SELECT string_agg(spec, ', ' ORDER BY spec)
    INTO missing
    FROM unnest(expected_columns) AS spec
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name || '.' || column_name) = spec
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'VTID-03237 post-condition: required columns missing after migration: %', missing;
  END IF;
END
$vtid_03237_post_guard$;

COMMIT;
