-- VTID-02000: Add description_long column for the product-detail drawer.
--
-- The existing `description` field is the single-line, HTML-stripped version
-- the marketplace sync has always written. It remains useful for card
-- summaries and search snippets.
--
-- `description_long` is the multi-paragraph readable form used by the
-- community-app drawer's "About this product" section. The Shopify sync
-- (this PR) populates it from `descriptionHtml` via a paragraph-preserving
-- strip. The CJ sync will populate it in a follow-up once the CJ enrichment
-- PR lands. Existing rows without it fall back to `description` on render.

BEGIN;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS description_long TEXT;

COMMENT ON COLUMN public.products.description_long IS
  'Multi-paragraph readable product description for the detail drawer. '
  'Falls back to the short `description` field when null.';

COMMIT;
