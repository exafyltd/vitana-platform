-- VTID-NAV-JOURNEY-NEWS (follow-up): Update HOME.OVERVIEW i18n by screen_id.
--
-- The prior migration 20260416150000_nav_catalog_my_journey_news.sql tried
-- to update HOME.OVERVIEW's i18n rows by hardcoded catalog_id UUID, but in
-- prod the row was seeded by `seed-nav-catalog.ts` (which uses
-- gen_random_uuid()), not by the SQL seed file — so the fixed UUID did not
-- match. Look up the catalog_id by screen_id instead.
--
-- AUTOPILOT.MY_JOURNEY was inserted correctly by the prior migration.
-- Idempotent. Safe to re-run.

BEGIN;

UPDATE nav_catalog_i18n AS i
SET
  title = 'Longevity News',
  description = 'Your home News Feed — the latest longevity news, research, and articles curated for you.',
  when_to_visit = 'When the user wants news, longevity news, the latest news, the news feed, what is new in longevity, articles, research updates, or simply the home screen.'
FROM nav_catalog AS c
WHERE i.catalog_id = c.id
  AND c.screen_id = 'HOME.OVERVIEW'
  AND c.tenant_id IS NULL
  AND i.lang = 'en';

UPDATE nav_catalog_i18n AS i
SET
  title = 'Longevity News',
  description = 'Dein News-Feed zu Hause — aktuelle Longevity-Nachrichten, Forschung und Artikel, für dich kuratiert.',
  when_to_visit = 'Wenn der Nutzer Nachrichten, Longevity-News, neueste Nachrichten, den News-Feed, Neuigkeiten zu Longevity, Artikel, Forschungs-Updates oder einfach die Startseite möchte.'
FROM nav_catalog AS c
WHERE i.catalog_id = c.id
  AND c.screen_id = 'HOME.OVERVIEW'
  AND c.tenant_id IS NULL
  AND i.lang = 'de';

-- Also add override_triggers to HOME.OVERVIEW so "news" / "longevity news"
-- phrases short-circuit straight to /home without competing with other
-- screens that happen to mention "news" in their descriptions.
UPDATE nav_catalog
SET override_triggers = '[
  {"lang": "en", "phrase": "news", "active": true},
  {"lang": "en", "phrase": "longevity news", "active": true},
  {"lang": "en", "phrase": "latest news", "active": true},
  {"lang": "en", "phrase": "show me the news", "active": true},
  {"lang": "en", "phrase": "open the news", "active": true},
  {"lang": "en", "phrase": "news feed", "active": true},
  {"lang": "de", "phrase": "nachrichten", "active": true},
  {"lang": "de", "phrase": "longevity news", "active": true},
  {"lang": "de", "phrase": "neueste nachrichten", "active": true},
  {"lang": "de", "phrase": "news-feed", "active": true}
]'::jsonb,
  updated_at = NOW()
WHERE screen_id = 'HOME.OVERVIEW'
  AND tenant_id IS NULL;

COMMIT;
