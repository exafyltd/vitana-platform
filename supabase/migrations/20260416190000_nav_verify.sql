-- Verification only — surfaces final nav_catalog state for HOME.OVERVIEW
-- and AUTOPILOT.MY_JOURNEY so we can confirm the wiring end-to-end.
-- No schema or data changes.

DO $$
DECLARE
  total_rows INT;
  home_title_en TEXT;
  home_wtv_en TEXT;
  home_triggers INT;
  auto_title_en TEXT;
  auto_wtv_en TEXT;
  auto_triggers INT;
BEGIN
  SELECT count(*) INTO total_rows FROM nav_catalog WHERE is_active;
  RAISE NOTICE 'Total active nav_catalog rows: %', total_rows;

  SELECT i.title, i.when_to_visit,
         jsonb_array_length(COALESCE(c.override_triggers, '[]'::jsonb))
    INTO home_title_en, home_wtv_en, home_triggers
  FROM nav_catalog c
  JOIN nav_catalog_i18n i ON i.catalog_id = c.id AND i.lang = 'en'
  WHERE c.screen_id = 'HOME.OVERVIEW' AND c.tenant_id IS NULL;
  RAISE NOTICE 'HOME.OVERVIEW en.title: %', home_title_en;
  RAISE NOTICE 'HOME.OVERVIEW en.when_to_visit: %', home_wtv_en;
  RAISE NOTICE 'HOME.OVERVIEW override_trigger count: %', home_triggers;

  SELECT i.title, i.when_to_visit,
         jsonb_array_length(COALESCE(c.override_triggers, '[]'::jsonb))
    INTO auto_title_en, auto_wtv_en, auto_triggers
  FROM nav_catalog c
  JOIN nav_catalog_i18n i ON i.catalog_id = c.id AND i.lang = 'en'
  WHERE c.screen_id = 'AUTOPILOT.MY_JOURNEY' AND c.tenant_id IS NULL;
  RAISE NOTICE 'AUTOPILOT.MY_JOURNEY en.title: %', auto_title_en;
  RAISE NOTICE 'AUTOPILOT.MY_JOURNEY en.when_to_visit: %', auto_wtv_en;
  RAISE NOTICE 'AUTOPILOT.MY_JOURNEY override_trigger count: %', auto_triggers;

  RAISE NOTICE '── screen_id prefix distribution ──';
END $$;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT split_part(screen_id, '.', 1) AS prefix, count(*) AS n
    FROM nav_catalog WHERE is_active
    GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '  prefix=% count=%', r.prefix, r.n;
  END LOOP;
END $$;
