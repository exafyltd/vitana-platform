-- VTID-03894 — record HOW a self-registered supplier's sales get attributed.
--
-- WHY A SECOND COLUMN AND NOT JUST `affiliate_network`
--
-- Knowing "they are on Awin" attributes nothing. `creditAwinConversions()`
-- pulls transactions from OUR publisher account and resolves each one's
-- merchant through `affiliate_program` rows keyed `awin_<advertiserId>`. Without
-- the supplier's advertiser id, a pulled conversion resolves to
-- `awin_unknown` and never reaches their merchant row — clicks recorded, sale
-- invisible, commission uncomputable.
--
-- So the id is the load-bearing half. The network name alone is a preference.
--
-- NO CHECK CONSTRAINT ON `affiliate_network` ON PURPOSE: the column predates
-- this VTID and already carries values written by the catalog ingest path
-- ('awin', 'admitad', and whatever a future network seeds). Constraining it
-- now would fail the migration on existing rows to police a field this form
-- is only one writer of. The allowed set is enforced in the gateway's zod
-- schema, at the only entry point a supplier can reach.

BEGIN;

ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS affiliate_advertiser_id TEXT;

COMMENT ON COLUMN public.merchants.affiliate_advertiser_id IS
  'VTID-03894: the supplier''s own id WITHIN affiliate_network (e.g. an Awin '
  'advertiser id). Conversions resolve through affiliate_program rows keyed '
  '<network>_<advertiser_id>; without this a pulled conversion cannot reach '
  'this merchant.';

-- Attribution looks up by the pair, never by network alone.
CREATE INDEX IF NOT EXISTS idx_merchants_affiliate_lookup
  ON public.merchants (affiliate_network, affiliate_advertiser_id)
  WHERE affiliate_advertiser_id IS NOT NULL;

COMMIT;
