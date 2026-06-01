-- Migration: 20260607000100_VTID_03237_register_ledger.sql
-- Purpose: Register VTID-03237 in vtid_ledger so the EXEC-DEPLOY
--          VTID-0541/0542 HARD GATE passes for the Video Shop backend deploy.
--          spec_status stays 'draft' — promotion to 'approved' is a human gate
--          (CLAUDE.md: "Always require spec_status=approved before execution").

INSERT INTO public.vtid_ledger (
  vtid, layer, module, status, title, description, summary, task_family,
  task_type, assigned_to, metadata, created_at, updated_at
)
VALUES (
  'VTID-03237',
  'PLATFORM',
  'COMMERCE',
  'in_progress',
  'Video Shop (Vitanaland) — backend slice: schema + shop-feed routes + cart attribution',
  'Adds the Video Shop surface over the existing products catalog + Universal Cart, with NO second commerce system. Migration 20260607000000_VTID_03237_video_shop_schema.sql creates shop_videos / shop_video_anchors / shop_saved_products / shop_video_events (non-OASIS funnel sink), threads source_video_id/source_creator_id attribution onto universal_cart_items + product_orders, and widens the source_surface CHECK to admit video_shop. Gateway: services/gateway/src/routes/shop-feed.ts (feed, video detail, anchor payload, saved CRUD, event ingestion) mounted at /api/v1/shop-feed; universal-cart.ts extended to accept video_shop + attribution and validate the anchored product is active/in_stock. V1 = curated/admin videos, add-to-cart only (NO wallet buy-now until the checkout bridge exists), community-gated behind a feature flag. Frontend /shop is a follow-up.',
  'Video Shop backend slice — new surface over products + Universal Cart, attribution only.',
  'PLATFORM',
  'COMMERCE',
  'claude-code',
  jsonb_build_object('source','feature_branch','registered_at',NOW(),'phase','V1','branch','claude/vitanaland-tiktok-marketplace-euTwf'),
  NOW(),
  NOW()
)
ON CONFLICT (vtid) DO UPDATE
  SET updated_at = NOW(),
      status = EXCLUDED.status,
      description = EXCLUDED.description;
