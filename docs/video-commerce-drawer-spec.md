# Vitanaland Video Commerce — Single-Product Drawer (Product Spec)

**Status:** Draft for review · **Date:** 2026-05-31
**Repos:** `vitana-platform` (Express/TS gateway + Supabase) · `vitana-v1` (React 18 + Vite web SPA)

Turns the TikTok-style video-commerce vision into a concrete, build-ready design that REUSES the existing system rather than forking it. Every identifier below has been verified against the real code; where the original concept invented names, the real names are used.

- **Universal Wallet** — `user_wallets` balances surfaced by `useWallet` (`currency_type` ∈ `USD | VTNA | CREDITS`) + Stripe deposits (`POST /api/v1/wallet/deposits/create`, currency `EUR | USD`). VTID work-tracking lives in `vtid_ledger` (governance, not money). Reused for checkout; we only add sale attribution.
- **Business Hub** — `vitana-v1/src/pages/BusinessHub.tsx`; sellers attach products to videos here.
- **Discover Marketplace** — `products` / `product_orders` (VTID-02000) + Universal Cart (`universal_carts` / `universal_cart_items` / `universal_cart_events`, VTID-03186). The shop video feed is a NEW surface over the SAME catalog. A product is buyable from the drawer only if it is an active marketplace product (`products.is_active = true`).
- **OASIS event sourcing** (`oasis_events`) — the analytics funnel is recorded as OASIS events, not a bespoke table. NOTE: `oasis_events` columns are `id, type, source, vtid, topic, service, status, message, payload (jsonb), metadata (jsonb), created_at` — there is **no** `aggregate_type` / `aggregate_id`. Use `type` for the event name and `payload`/`metadata` for `{ video_id, anchor_id, product_id, ... }`.
- **Multi-tenant**: every new table carries `tenant_id`; gateway routes resolve `req.identity.{user_id, tenant_id}` via the Supabase-JWT middleware (`requireAuth` / `optionalAuth` in `services/gateway/src/middleware/auth-supabase-jwt.ts`); Supabase RLS enforces isolation.

Design principle: catalog, Universal Cart, checkout, and wallet do NOT fork. We add a presentation + binding + analytics layer (`shop_videos`, `shop_video_anchors`, `shop_saved_products`) and thread sale attribution through the existing cart/order path.

## 1. Scope

V1: vertical short-video feed; one primary product anchor per video; single-product drawer (Vaul bottom sheet — the existing `components/ui/drawer.tsx` wraps `vaul`) over the paused video with snap points; expand to full PDP (reuse `ProductDetailsDrawer` + `useMarketplaceFeed`/`useMarketplace` product shape); add-to-cart / buy-now via Universal Cart (`useUniversalCart` → `/api/v1/universal-cart/*`) + wallet/Stripe checkout; sale attribution to source video + creator; OASIS event funnel; minimal seller studio (create video, attach anchor, publish→moderation).

Out of scope (later): multi-product cards, live shopping (LiveKit/Daily — note `orb-livekit.ts` exists today only for ORB voice, not video), countdown stickers, affiliate payout calculation (only persist attribution now).

## 2. Architecture fit

- New gateway route module(s) under `services/gateway/src/routes/` following the `universal-cart.ts` conventions: `/api/v1/shop-feed/*` and `/api/v1/shop-studio/*`. Register in the gateway router exactly like the existing `universal-cart.ts` / `discover-feed.ts` / `creators.ts` modules. Zod validation, `{ ok: true, ... }` / `{ ok: false, error, detail }` envelope, Supabase-JWT auth via `requireAuth` / `optionalAuth`, `req.identity` for `user_id` / `tenant_id`. Cart-coupled writes reuse the universal-cart community-role gate pattern (`getUserContext` via `me_context` RPC + `getActiveRole` from `user_tenants.active_role`; 403 `cart_unavailable_for_role` for non-community).
- New Supabase tables created via SQL migration in `supabase/migrations/` (Supabase is the source of truth; Prisma here is only `@prisma/client` for event-sourcing models — DDL is SQL, not Prisma schema) with RLS policies keyed on `tenant_id` / `auth.uid()`, mirroring the VTID-03186 and VTID-02000 patterns. Update `DATABASE_SCHEMA.md` in the same commit (canonical-schema rule).
- Short videos: store the clip and serve via `playback_url` (HLS/MP4 from Supabase Storage or a stream provider e.g. Cloudflare Stream/Mux). LiveKit/Daily remain for LIVE only. Keep provider-agnostic via `playback_url` + `poster_url`.
- Analytics funnel = OASIS events emitted through the existing `emitOasisEvent` service (`services/gateway/src/services/oasis-event-service.ts`), `type` e.g. `shop.video.impression`, `source: 'shop-feed-gateway'`, `payload: { video_id, anchor_id, product_id, ... }`. A projection/worker reads OASIS to recompute ranking.

## 3. Database schema (Supabase SQL DDL + RLS)

All names verified against `supabase/migrations/20260416120000_vtid_02000_marketplace_foundation.sql` (`products`, `merchants`, `product_orders`) and `supabase/migrations/20260605000000_VTID_03186_universal_cart_schema.sql` (`universal_cart_items`). `products` has no `variant` table — there is a single row per `(source_network, source_product_id)` with `availability` ∈ `in_stock|out_of_stock|preorder|discontinued|unknown`, `price_cents INT`, `currency CHAR(3)`, `rating NUMERIC(3,2)`, `review_count INT`, `images TEXT[]`. So V1 anchors a product (no variant_id); a future `variant_id` stays nullable.

### NEW: `shop_videos`
```sql
CREATE TABLE public.shop_videos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID,                                  -- nullable, mirrored from user_tenants (matches universal_carts.tenant_id pattern)
  creator_user_id   UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  business_id       UUID REFERENCES public.merchants(id),  -- nullable; seller/merchant the video promotes
  caption           TEXT,
  playback_url      TEXT NOT NULL,                         -- HLS/MP4; provider-agnostic
  poster_url        TEXT,
  duration_ms       INT,
  aspect_ratio      TEXT NOT NULL DEFAULT '9:16',
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','processing','active','paused','removed')),
  moderation_status TEXT NOT NULL DEFAULT 'pending'
                      CHECK (moderation_status IN ('pending','approved','rejected')),
  rank_score        NUMERIC NOT NULL DEFAULT 0,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shop_videos_feed_idx
  ON public.shop_videos (status, moderation_status, rank_score DESC)
  WHERE status = 'active' AND moderation_status = 'approved';
CREATE INDEX shop_videos_creator_idx ON public.shop_videos (creator_user_id, created_at DESC);
CREATE INDEX shop_videos_tenant_idx  ON public.shop_videos (tenant_id) WHERE tenant_id IS NOT NULL;
```

### NEW: `shop_video_anchors`
```sql
CREATE TABLE public.shop_video_anchors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID,
  video_id        UUID NOT NULL REFERENCES public.shop_videos(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL REFERENCES public.products(id),
  variant_id      UUID,                                    -- reserved; products has no variants in V1, stays NULL
  is_primary      BOOLEAN NOT NULL DEFAULT TRUE,
  label           TEXT NOT NULL DEFAULT 'Shop now',
  badge_price_cents INT,                                   -- matches products.price_cents units (cents)
  appear_at_ms    INT NOT NULL DEFAULT 0,
  pos_x           NUMERIC NOT NULL DEFAULT 0.5,
  pos_y           NUMERIC NOT NULL DEFAULT 0.82,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One primary anchor per video = TikTok single-anchor model.
CREATE UNIQUE INDEX shop_video_anchors_one_primary
  ON public.shop_video_anchors (video_id) WHERE is_primary = TRUE;
CREATE INDEX shop_video_anchors_video_idx   ON public.shop_video_anchors (video_id);
CREATE INDEX shop_video_anchors_product_idx ON public.shop_video_anchors (product_id);
```

### NEW: `shop_saved_products`
```sql
CREATE TABLE public.shop_saved_products (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID,
  user_id     UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES public.products(id),
  video_id    UUID REFERENCES public.shop_videos(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);
CREATE INDEX shop_saved_products_user_idx ON public.shop_saved_products (user_id, created_at DESC);
```

### ANALYTICS: reuse `oasis_events` — no new table
Funnel events are emitted via `emitOasisEvent`. There is no `aggregate_*` column; carry IDs in `payload`. Example row: `type='shop.video.add_to_cart'`, `source='shop-feed-gateway'`, `payload={ video_id, anchor_id, product_id, source_creator_id }`.

### ADDITIVE attribution columns (nullable → non-breaking)
```sql
-- Universal Cart item: thread source video + creator through the existing add-to-cart path.
ALTER TABLE public.universal_cart_items ADD COLUMN IF NOT EXISTS source_video_id   UUID;
ALTER TABLE public.universal_cart_items ADD COLUMN IF NOT EXISTS source_creator_id UUID;
-- product_orders: snapshot attribution at purchase for future affiliate payout (VTID-02000 table).
ALTER TABLE public.product_orders ADD COLUMN IF NOT EXISTS source_video_id   UUID;
ALTER TABLE public.product_orders ADD COLUMN IF NOT EXISTS source_creator_id UUID;
```
NOTE: `universal_cart_items` already carries `source_surface` (`web|mobile|voice|autopilot|community`) and `source_ref` — adds from the shop feed set `source_surface` to a new allowed value `video_shop` (extend `universal_cart_items_source_surface_check`) and `source_ref = <shop_videos.id>`, with the explicit `source_video_id` / `source_creator_id` columns for typed joins. `product_orders` already has `attribution_surface` / `attribution_recommendation_id`; set `attribution_surface = 'video_shop'` alongside the new typed columns.

### RLS notes (mirror VTID-03186 / VTID-02000)
- `shop_videos`, `shop_video_anchors`: `authenticated` `SELECT` only for rows where `status='active' AND moderation_status='approved'` (the public feed); creators get full CRUD on their own rows via `creator_user_id = auth.uid()` (videos) and parent-video ownership (anchors), exactly like the cart→cart_items parent-ownership policy. `service_role` `ALL` (gateway writes / moderation).
- `shop_saved_products`: owner-only (`user_id = auth.uid()`) for SELECT/INSERT/DELETE; `service_role` `ALL`.
- Funnel writes to `oasis_events` go through `service_role` only (consistent with `universal_cart_events` and the events ingest path).
- `GRANT SELECT` to `authenticated`; `GRANT ALL` to `service_role` on all three new tables (defense-in-depth alongside RLS, matching the VTID-03186 grants block).

## 4. API endpoints (all `/api/v1`, `{ ok }` envelope, Zod, Supabase-JWT auth)

Feed (auth optional/personalized via `optionalAuth`):
- `GET /api/v1/shop-feed?cursor=&limit=20` → `{ ok:true, items:[{ id, caption, playback:{ playback_url, poster_url, duration_ms, aspect_ratio }, creator:{ user_id, vitana_id, display_name }, primary_anchor:{ id, label, appear_at_ms, pos_x, pos_y, badge_price_cents, product:{ id, title, brand, images, rating, review_count, price_cents, currency, availability } } }], next_cursor }`. Only `status='active' AND moderation_status='approved'` videos whose primary anchor `product.is_active = true`.
- `GET /api/v1/shop-feed/videos/:id` → single video + anchors (deep link/share).
- `GET /api/v1/shop-feed/videos/:id/anchor` → drawer (peek) payload: product detail (reuse the `discover/product/:id` shape from `discover-feed.ts`, including `dosage`, `serving_size`, `evidence_links`, `safety_notes`), `availability`, trust markers, shipping (`ships_to_countries`/`ships_to_regions`), compliance/health disclaimer.

PDP: reuse the existing product-detail endpoint `GET /api/v1/discover/product/:id`; extend with longevity blocks (`ingredients_primary`, supplement facts via `serving_size`/`servings_per_container`, protocols, `contraindicated_with_*`, reviews, seller/`merchants` profile) + `anchor_context`.

Cart/checkout (REUSE universal-cart routes, extend body — do NOT fork):
- `POST /api/v1/universal-cart/items` accepts (additively) `source_video_id` / `source_creator_id` and `source_surface:'video_shop'` / `source_ref:<video_id>`; persists them on `universal_cart_items`. Request schema stays the existing `AddItemBody` (`product_id` uuid, `item_type` ∈ `supplement|partner_product`, `quantity`, `merchant_id?`, `unit_price_cents_snapshot?`, `currency_snapshot?`, `metadata?`) plus the two new optional uuid fields.
- Checkout copies `source_video_id` / `source_creator_id` onto the `product_orders` snapshot (the existing per-item exit calls `POST /api/v1/universal-cart/items/:itemId/complete`).
- Buy-now = add ephemeral item then run the single-item `product_orders` flow with a single-item scope.
- Wallet UX: show `USD / VTNA / CREDITS` balance from `useWallet` (`GET /api/v1/wallet/balance` returns `accounts:[{ currency, balance_minor, status }]`); insufficient → Stripe top-up via `POST /api/v1/wallet/deposits/create` ({ amount_minor, currency:'EUR'|'USD' }) then poll `GET /api/v1/wallet/deposits/:id` and retry.

Saved:
- `POST /api/v1/shop-feed/saved { product_id, video_id? }`, `DELETE /api/v1/shop-feed/saved/:product_id`, `GET /api/v1/shop-feed/saved`.

Events:
- `POST /api/v1/shop-feed/events` (single or batch) → emits OASIS events via `emitOasisEvent`: `shop.video.impression`, `shop.video.hold_2s`, `shop.anchor.tap`, `shop.drawer.open`, `shop.drawer.expand`, `shop.variant.change`, `shop.add_to_cart`, `shop.buy_now`, `shop.checkout.start`, `shop.purchase`, `shop.save`, `shop.share`, `shop.drawer.close`.

Seller studio (role-gated — reuse `creators.ts` + community/seller role checks):
- `POST /api/v1/shop-studio/videos` (create draft + return upload target),
- `POST /api/v1/shop-studio/videos/:id/anchors`, `PATCH`/`DELETE /api/v1/shop-studio/anchors/:id` (enforce single primary via the partial-unique index),
- `GET /api/v1/shop-studio/videos/:id/preview` (anchor simulator),
- `POST /api/v1/shop-studio/videos/:id/publish` (validate has primary anchor + active product + processed video → moderation queue, status `processing`→`active` after `moderation_status='approved'`).

## 5. UI states — single-product drawer (vitana-v1, React 18 + Vaul + React Query v5 + shadcn/ui + Tailwind)

New page `src/pages/ShopFeed.tsx` (full-screen vertical video feed), registered via the canonical path: add a `SCREEN_MANIFEST` entry in `src/navigation/screens.manifest.ts` (e.g. `screen_id:'shop.feed'`, `route:'/shop'`, `domain:'discover'`, `lazy_import:'pages/ShopFeed'`, `requires_auth:true`, `roles:['community']`), add the lazy route in `src/App.tsx`, stamp with `withScreenId(Component, SCREEN_IDS.SHOP_FEED)`, and add a nav entry in `src/config/navigation.ts` if surfaced in Discover sub-nav.

New hooks: `useShopFeed` (mirror `useMarketplaceFeed` in `src/hooks/useMarketplace.ts` — same `GATEWAY_URL` normalization + `authHeaders()` + React Query pattern), `useShopVideoAnchor`, `useShopEvents` (batched POST to `/api/v1/shop-feed/events`). REUSE `useUniversalCart` (`src/hooks/useUniversalCart.ts` → `addItem({ product_id, item_type:'partner_product', quantity, source_surface:'video_shop', source_ref, ... })`) and `useWallet`. Extend the existing `ProductDetailsDrawer` (`src/components/discover/ProductDetailsDrawer.tsx`) — which today uses shadcn `Sheet` on desktop and the Vaul-backed `Drawer` on mobile with NO snap points — to add snap points and the pill/peek/PDP states. Product selection flows through the existing `ProductSelectionContext` (`selectProduct` / `selectedProduct` / `clearSelection`).

Playback via HTML5 `<video>` (+ HLS.js if needed); IntersectionObserver autoplays the on-screen clip, pauses neighbors, prebuffers ±1.

Vaul `snapPoints`: `[0.12 (pill only/closed), 0.45 (PEEK), 0.92 (FULL_PDP)]`; backdrop dims + tap-to-close; video persists dimmed behind. (Vaul's `Drawer.Root` already wired in `components/ui/drawer.tsx` with `shouldScaleBackground`; add `snapPoints` + `activeSnapPoint` control.)

State machine:
- IDLE (autoplay muted; pill hidden until `appear_at_ms`; emit `shop.video.impression`, `shop.video.hold_2s` at 2s) →
- ANCHOR_VISIBLE (pill: thumb + `badge_price_cents` + `label`) →
- DRAWER_OPENING (tap pill → snap PEEK, PAUSE video, emit `shop.anchor.tap` + `shop.drawer.open`, refetch live anchor via `useShopVideoAnchor`) →
- PEEK (image, title, price, rating, trust chips, Add to cart + Buy now, Save) →
- ADDING_TO_CART (optimistic badge; `useUniversalCart.addItem` with source attribution; `shop.add_to_cart`) →
- ATC_SUCCESS (toast via `notify()`/i18n `t()` from `@/lib/i18n-toast`; CTA→View cart) →
- EXPANDED_PDP (drag to 0.92; full PDP; `shop.drawer.expand`) →
- BUY_NOW (checkout sub-sheet; wallet balance from `useWallet`; `shop.buy_now` + `shop.checkout.start` → `shop.purchase`) →
- INSUFFICIENT_FUNDS (CTA→Top up & buy; `wallet/deposits/create` Stripe) →
- OUT_OF_STOCK (`availability !== 'in_stock'` → CTA disabled → Notify me) →
- GUEST_GATE (not signed in → sign-in, preserve state, resume) →
- DISMISSING (drag down/backdrop → close, RESUME video at paused position, `shop.drawer.close`).

(No VARIANT_SELECTING state in V1 — `products` has no variants; reserved for when `variant_id` is populated.)

Loading/empty/error per state: pill data comes inline from the feed so the peek never shows blank; skeletons for PDP; inline retry on network error; gateway role 403 `cart_unavailable_for_role` → render community-only empty state (per `useUniversalCart.roleBlocked`); 409 stock conflict refreshes product availability; unavailable video/paused product → "No longer available", hide CTA. Playback rules: only on-screen plays; drawer open pauses (not stops) and close resumes; lock vertical swipe while sheet above PEEK; global persistent mute; optimistic cart reconciled against the `addItem` response. All user-visible strings via i18n (DE-first, `t()` / `notify()` per the vitana-v1 i18n hard rule).

## 6. Trust, compliance & moderation (longevity)

Every drawer/PDP shows a health disclaimer (reuse `AffiliateDisclosure` + a health-claims disclaimer block) + seller-verification badge (from `merchants` / creator profile). Age/region gating resolved server-side from `app_users` geo (`country_code` / `delivery_country_code` / `region_group`) + `geo_policy` + `user_limitations` (allergies, contraindications, medications) — the same limitations-filter substrate the marketplace feed already applies. Publish runs through moderation (`moderation_status='pending'` → admin review of video claims + product claims + creator disclosure) before going `active`; restricted longevity categories (via `products.contraindicated_with_*` / `condition_product_mappings`) require manual approval.

## 7. Ranking & events pipeline

Client emits OASIS events; a projection/worker recomputes `shop_videos.rank_score = w1·watch_completion + w2·anchor_ctr + w3·atc_rate + w4·conv_rate + w5·health_relevance − w6·report_rate`. Shop and Discover share product-level signals via the existing `product_outcome_rollup` materialized view and `product_clicks` / `product_orders`. The worker reads `oasis_events` (filtered by `type LIKE 'shop.%'` + `payload->>'video_id'`) — consistent with the OASIS-as-source-of-truth rule; polling/heartbeats are NOT emitted as events.

## 8. Build sequence

- V1: feed + single-product drawer + ATC/buy-now (Universal Cart + wallet/Stripe) + PDP + OASIS events.
- V1.1: seller studio + Shopify catalog import into `products` (reuse `catalog-ingest.ts` / `internal-marketplace-sync.ts`).
- V1.2: affiliate — compute commission from `product_orders.source_creator_id`, pay via the wallet ledger to the creator wallet on fulfillment.
- V1.3: live shopping with pinned anchor over LiveKit/Daily (extend the `orb-livekit.ts` token pattern to a video room).

## 9. Open questions

1) Commission model for V1.2 (flat % / per-category from `merchants.commission_rate` / per-creator).
2) Can creators anchor other businesses' products in V1 or only affiliate-enabled merchants?
3) `VTNA` / `CREDITS` usage in video checkout — same offsets as Discover, or `USD`/Stripe only at launch?
4) Short-video storage/transcode provider (Supabase Storage vs Cloudflare Stream/Mux) + OASIS event retention for the funnel.
