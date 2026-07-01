-- VCAOP: allow 'admitad' as a marketplace catalog source.
--
-- marketplace_sources_config originally constrained source_network to
-- ('shopify','cj','amazon','awin','rakuten','manual'). Admitad was wired as a
-- conversion/postback network only (rewards crediting) and never had a product
-- catalog source. Adding Admitad product-feed ingestion (admitad-sync.ts) needs
-- 'admitad' to be an accepted source_network so an admin can store its config row.
--
-- Idempotent: drops the auto-named CHECK if present and re-adds it with admitad.

ALTER TABLE public.marketplace_sources_config
  DROP CONSTRAINT IF EXISTS marketplace_sources_config_source_network_check;

ALTER TABLE public.marketplace_sources_config
  ADD CONSTRAINT marketplace_sources_config_source_network_check
  CHECK (source_network IN ('shopify','cj','amazon','awin','rakuten','admitad','manual'));
