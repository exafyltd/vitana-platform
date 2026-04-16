-- Diagnostic only — prints home-like screen_ids via RAISE NOTICE so the
-- RUN-MIGRATION workflow log surfaces them. No schema/data changes.

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '── nav_catalog rows matching /home or HOME.* ──';
  FOR r IN
    SELECT screen_id, route, tenant_id, is_active
    FROM nav_catalog
    WHERE route = '/home' OR screen_id LIKE 'HOME%'
    ORDER BY screen_id NULLS LAST, tenant_id NULLS LAST
  LOOP
    RAISE NOTICE 'screen_id=% route=% tenant_id=% active=%', r.screen_id, r.route, r.tenant_id, r.is_active;
  END LOOP;

  RAISE NOTICE '── AUTOPILOT.MY_JOURNEY row ──';
  FOR r IN
    SELECT screen_id, route, tenant_id, is_active, priority
    FROM nav_catalog
    WHERE screen_id = 'AUTOPILOT.MY_JOURNEY'
  LOOP
    RAISE NOTICE 'screen_id=% route=% tenant_id=% active=% priority=%', r.screen_id, r.route, r.tenant_id, r.is_active, r.priority;
  END LOOP;

  RAISE NOTICE '── Total nav_catalog rows, and distinct screen_id prefix counts ──';
  RAISE NOTICE 'total rows = %', (SELECT count(*) FROM nav_catalog);
  FOR r IN
    SELECT split_part(screen_id, '.', 1) AS prefix, count(*) AS n
    FROM nav_catalog GROUP BY 1 ORDER BY 2 DESC
  LOOP
    RAISE NOTICE '  prefix=% count=%', r.prefix, r.n;
  END LOOP;
END $$;
