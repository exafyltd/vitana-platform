-- VTID-02000 (Discover marketplace) — allow 'admitad_feed' as a
-- marketplace_sources_config.source_network value.
--
-- The new Admitad product-feed catalog importer (VCAOP) registers as
-- provider key 'admitad_feed' — deliberately distinct from the existing
-- 'admitad' network (the hand-curated AliExpress/Bodylab24 seed rows +
-- postback conversion crediting), so the automated feed sync can never
-- collide with or silently overwrite the manually curated rows.
--
-- impact-allow-solo-migration: schema-only (CHECK constraint widen). The
-- gateway code that depends on this value (admitad-sync.ts,
-- providers/admitad.ts) ships in the same PR.

BEGIN;

ALTER TABLE marketplace_sources_config
  DROP CONSTRAINT IF EXISTS marketplace_sources_config_source_network_check;

ALTER TABLE marketplace_sources_config
  ADD CONSTRAINT marketplace_sources_config_source_network_check
  CHECK (source_network = ANY (ARRAY[
    'shopify'::text, 'cj'::text, 'amazon'::text, 'awin'::text,
    'rakuten'::text, 'manual'::text, 'admitad_feed'::text
  ]));

COMMIT;

-- DOWN (rollback):
-- BEGIN;
-- ALTER TABLE marketplace_sources_config DROP CONSTRAINT IF EXISTS marketplace_sources_config_source_network_check;
-- ALTER TABLE marketplace_sources_config ADD CONSTRAINT marketplace_sources_config_source_network_check
--   CHECK (source_network = ANY (ARRAY['shopify'::text,'cj'::text,'amazon'::text,'awin'::text,'rakuten'::text,'manual'::text]));
-- COMMIT;
