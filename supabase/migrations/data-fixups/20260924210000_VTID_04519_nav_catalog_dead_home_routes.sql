-- VTID-04513 / VTID-04519: navigator rows that send members to the news feed.
--
-- nav_catalog rows win over the code catalog (nav-catalog-db.ts, "DB rows
-- always win on conflict"). These four shared rows all point at /home, the
-- Longevity News feed, because VTID-01900 (vitana-v1) removed the Home
-- sub-pages they described:
--   HOME.MATCHES  -> the real matches page is /me/matches (MatchesPage)
--   HOME.CONTEXT, HOME.ACTIONS, HOME.AI_FEED -> removed pages, no successor
--
-- Deactivate, never delete: is_active=false keeps the row (and its i18n)
-- recoverable. Idempotent.
UPDATE public.nav_catalog
   SET route = '/me/matches', updated_at = now()
 WHERE screen_id = 'HOME.MATCHES' AND tenant_id IS NULL AND route <> '/me/matches';

UPDATE public.nav_catalog
   SET is_active = false, updated_at = now()
 WHERE screen_id IN ('HOME.CONTEXT', 'HOME.ACTIONS', 'HOME.AI_FEED')
   AND tenant_id IS NULL AND is_active = true;
