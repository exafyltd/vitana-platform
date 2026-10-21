-- Inspect what tables from the foundation migration actually made it through.
DO $$
DECLARE
  t RECORD;
  v_tables TEXT[] := ARRAY[
    'merchants', 'products', 'tenant_catalog_overrides', 'catalog_sources',
    'geo_policy', 'user_limitations', 'condition_product_mappings',
    'default_feed_config', 'product_clicks', 'product_orders', 'product_outcomes',
    'canonical_fact_keys', 'canonical_fact_key_review_queue',
    'catalog_vocabulary', 'catalog_vocabulary_synonyms',
    'wearable_waitlist', 'limitation_bypass_log'
  ];
  v_t TEXT;
  v_found BOOLEAN;
BEGIN
  FOREACH v_t IN ARRAY v_tables LOOP
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = v_t
    ) INTO v_found;
    RAISE NOTICE 'table % exists: %', v_t, v_found;
  END LOOP;

  -- Also check get_region_group function
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'get_region_group'
  ) INTO v_found;
  RAISE NOTICE 'function get_region_group exists: %', v_found;

  -- Check vector extension
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') INTO v_found;
  RAISE NOTICE 'extension vector installed: %', v_found;
END $$;
