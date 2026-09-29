-- VTID-04740 (follow-up): an anonymous buyer's order has no tenant.
--
-- 20260929120000 let product_orders.user_id be NULL for signed-out buyers who
-- arrive through a referral link. A signed-out click also records no tenant
-- (product_clicks.tenant_id is already nullable), and the Awin order sync
-- copies the click's tenant onto the order, so product_orders.tenant_id must
-- accept NULL too or the upsert fails and the sale and its commission are lost.
--
-- NULL is the honest value for an unknown buyer's tenant; the recommender's
-- tenant is not the buyer's. RLS on product_orders does not use tenant_id.

ALTER TABLE public.product_orders ALTER COLUMN tenant_id DROP NOT NULL;

COMMENT ON COLUMN public.product_orders.tenant_id IS
  'Buyer''s tenant. NULL when the buyer was signed out (anonymous referral sale, VTID-04740).';
