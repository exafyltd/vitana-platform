-- VTID-NAV-JOURNEY-NEWS: Wire My Journey (Autopilot Dashboard) and Longevity
-- News into the Vitana Navigator catalog.
--
-- Context: users saying "open my journey" were being routed to /me/profile
-- because the nav_catalog had no entry for /autopilot and HOME.OVERVIEW's
-- i18n didn't mention news at all. Gemini fell back to the closest match
-- (PROFILE.ME) since it contains the word "user profile / my profile".
--
-- This migration:
--   1. Strengthens HOME.OVERVIEW (/home) i18n so the navigator maps
--      "news", "longevity news", "latest news" there (VTID-01900: /home
--      is the standalone News Feed).
--   2. Adds AUTOPILOT.MY_JOURNEY (/autopilot) so "my journey",
--      "meine Reise", "90-day journey", "autopilot journey" land on the
--      Autopilot Dashboard — the 90-day journey aligned to the Calendar.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- ── 1. Refresh HOME.OVERVIEW i18n to emphasize Longevity News ───────────────
-- Matches the i18n already shipped in the TS catalog fallback so the runtime
-- behavior is consistent whether the gateway reads from DB or falls back.

UPDATE nav_catalog_i18n
SET
  title = 'Longevity News',
  description = 'Your home News Feed — the latest longevity news, research, and articles curated for you.',
  when_to_visit = 'When the user wants news, longevity news, the latest news, the news feed, what is new in longevity, articles, research updates, or simply the home screen.'
WHERE catalog_id = '3bab8e1f-3242-565f-bc1c-ff64ff85e5c2'::uuid
  AND lang = 'en';

UPDATE nav_catalog_i18n
SET
  title = 'Longevity News',
  description = 'Dein News-Feed zu Hause — aktuelle Longevity-Nachrichten, Forschung und Artikel, für dich kuratiert.',
  when_to_visit = 'Wenn der Nutzer Nachrichten, Longevity-News, neueste Nachrichten, den News-Feed, Neuigkeiten zu Longevity, Artikel, Forschungs-Updates oder einfach die Startseite möchte.'
WHERE catalog_id = '3bab8e1f-3242-565f-bc1c-ff64ff85e5c2'::uuid
  AND lang = 'de';

-- ── 2. Insert AUTOPILOT.MY_JOURNEY (route /autopilot) ────────────────────────
-- Uses a deterministic UUID so the row is stable across replays and matches
-- any ad-hoc references. ON CONFLICT on the shared-screen partial unique
-- index keeps this idempotent.

INSERT INTO nav_catalog (
  id, screen_id, tenant_id, route, category, access, anonymous_safe,
  priority, related_kb_topics, context_rules, override_triggers, is_active
)
VALUES (
  'a1b7c9d0-4e5f-4a6b-9c8d-1e2f3a4b5c6d'::uuid,
  'AUTOPILOT.MY_JOURNEY',
  NULL,
  '/autopilot',
  'autopilot',
  'authenticated',
  FALSE,
  5,
  '{}'::jsonb,
  '{}'::jsonb,
  '[
    {"lang": "en", "phrase": "open my journey", "active": true},
    {"lang": "en", "phrase": "my journey", "active": true},
    {"lang": "en", "phrase": "show my journey", "active": true},
    {"lang": "en", "phrase": "autopilot journey", "active": true},
    {"lang": "en", "phrase": "90-day journey", "active": true},
    {"lang": "en", "phrase": "my 90 day journey", "active": true},
    {"lang": "de", "phrase": "meine reise", "active": true},
    {"lang": "de", "phrase": "meine reise öffnen", "active": true},
    {"lang": "de", "phrase": "autopilot reise", "active": true},
    {"lang": "de", "phrase": "90 tage reise", "active": true}
  ]'::jsonb,
  TRUE
)
ON CONFLICT (screen_id) WHERE tenant_id IS NULL
DO UPDATE SET
  route = EXCLUDED.route,
  category = EXCLUDED.category,
  access = EXCLUDED.access,
  anonymous_safe = EXCLUDED.anonymous_safe,
  priority = EXCLUDED.priority,
  override_triggers = EXCLUDED.override_triggers,
  is_active = TRUE,
  updated_at = NOW();

-- Capture the catalog_id for i18n inserts (works whether the row was newly
-- inserted or upserted onto an existing screen_id).
WITH autopilot_row AS (
  SELECT id FROM nav_catalog
  WHERE screen_id = 'AUTOPILOT.MY_JOURNEY' AND tenant_id IS NULL
  LIMIT 1
)
INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
SELECT id, 'en',
  'My Journey',
  'Your Autopilot Dashboard — the 90-day journey prepared for you: waves, milestones, and recommended actions aligned to your calendar.',
  'When the user asks to open my journey, see my journey, show my journey, the autopilot journey, my 90-day journey, the 90-day plan, the autopilot dashboard, my plan, or what is on their journey today. This is NOT the user profile — "my journey" means the Autopilot Dashboard.'
FROM autopilot_row
ON CONFLICT (catalog_id, lang) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  when_to_visit = EXCLUDED.when_to_visit;

WITH autopilot_row AS (
  SELECT id FROM nav_catalog
  WHERE screen_id = 'AUTOPILOT.MY_JOURNEY' AND tenant_id IS NULL
  LIMIT 1
)
INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
SELECT id, 'de',
  'Meine Reise',
  'Dein Autopilot-Dashboard — die 90-Tage-Reise, die für dich vorbereitet wurde: Wellen, Meilensteine und empfohlene Aktionen, abgestimmt auf deinen Kalender.',
  'Wenn der Nutzer meine Reise öffnen, meine Reise sehen, die Autopilot-Reise, meine 90-Tage-Reise, den 90-Tage-Plan, das Autopilot-Dashboard, meinen Plan, oder was heute auf seiner Reise ansteht, anfragt. Das ist NICHT das Nutzerprofil — "meine Reise" bedeutet das Autopilot-Dashboard.'
FROM autopilot_row
ON CONFLICT (catalog_id, lang) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  when_to_visit = EXCLUDED.when_to_visit;

COMMIT;
