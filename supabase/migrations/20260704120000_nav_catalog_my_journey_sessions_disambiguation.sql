-- BOOTSTRAP-NAV-JOURNEY-SESSIONS: fix live scoring for AUTOPILOT.MY_JOURNEY
--
-- Root cause: consultNavigator's scoring candidates come from
-- getCatalogForTenant() (nav-catalog-db.ts), which reads THIS TABLE, not the
-- compile-time navigation-catalog.ts fallback. A prior code-only fix
-- (PR #2789) edited the static file's when_to_visit for AUTOPILOT.MY_JOURNEY
-- to recognize "Vollversion"/"Einführung"/"guided journey" — but the DB rows
-- for this screen (both platform='mobile' and platform='desktop', seeded by
-- 20260416150000_nav_catalog_my_journey_news.sql /
-- 20260616120000_nav_catalog_desktop.sql) were never updated, so that fix had
-- NO EFFECT on live behavior. This migration is the real fix.
--
-- Observed bug: "Zeig mir mal meinen Screen mit der guided Journey mit den
-- Sessions" resolved to BUSINESS.SERVICES_EVENTS (Business Hub > My Events)
-- instead of AUTOPILOT.MY_JOURNEY. Cause: My Journey's when_to_visit never
-- mentioned "sessions" at all, while Business Hub's My Events explicitly
-- claims that word ("sessions they host/offer as a provider"). The user's
-- own journey genuinely has "sessions" (the guided step-by-step ORB
-- conversations per wave — see greeting-pools.ts "shall we start with your
-- first session together?", journey-foundation/session-summary-writer.ts)
-- but the catalog never said so, so any mention of "session(s)" defaulted to
-- Business Hub. Follow-up correction ("Guided Journey" alone) also failed to
-- resolve because the DB row still lacked that wording.
--
-- Fix: update when_to_visit (the primary scoring signal) for both platform
-- rows, both languages, to (a) name the two views — Guided/Einführung vs
-- Full/Vollversion — and (b) disambiguate "sessions" as belonging to the
-- user's OWN guided journey, distinct from sessions/classes they host as a
-- provider (Business Hub).
--
-- Idempotent. Safe to re-run.

BEGIN;

UPDATE nav_catalog_i18n
SET when_to_visit = 'When the user asks to open my journey, see my journey, show my journey, the autopilot journey, my 90-day journey, the 90-day plan, the autopilot dashboard, my plan, or what is on their journey today. ALSO when the user refers to either VIEW of their journey by name — the GUIDED journey / the guided version / the "Einführung", OR the FULL app / the full version / the "Vollversion" / the full view — or asks to switch between the guided and full views of their journey. ALSO when the user asks about the SESSIONS of their OWN journey — e.g. "the next session in my journey", "my journey session", "the screen with the sessions of my guided journey" — these are the step-by-step conversations INSIDE their own 90-day journey, NOT sessions/classes they host as a provider for others (that is the Business Hub). This is NOT the user profile — "my journey" means the Autopilot Dashboard.',
    description = 'Your Autopilot Dashboard — the 90-day journey prepared for you: waves, milestones, and recommended actions aligned to your calendar. It has two views the user can switch between: the GUIDED journey (the "Einführung", step-by-step, one session at a time) and the FULL app (the "Vollversion", everything at once).',
    updated_at = NOW()
WHERE lang = 'en'
  AND catalog_id IN (SELECT id FROM nav_catalog WHERE screen_id = 'AUTOPILOT.MY_JOURNEY' AND tenant_id IS NULL);

UPDATE nav_catalog_i18n
SET when_to_visit = 'Wenn der Nutzer meine Reise öffnen, meine Reise sehen, die Autopilot-Reise, meine 90-Tage-Reise, den 90-Tage-Plan, das Autopilot-Dashboard, meinen Plan, oder was heute auf seiner Reise ansteht, anfragt. AUCH wenn der Nutzer eine der beiden ANSICHTEN seiner Reise beim Namen nennt — die GEFÜHRTE Reise / die geführte Journey / die "Einführung", ODER die VOLLVERSION / die volle App / die volle Version — oder zwischen geführter und voller Ansicht seiner Reise wechseln möchte. AUCH wenn der Nutzer nach den SESSIONS SEINER EIGENEN Journey fragt — z.B. "die nächste Session meiner Reise", "meine Journey-Session", "der Screen mit den Sessions meiner geführten Journey" — das sind die Schritt-für-Schritt-Gespräche INNERHALB seiner eigenen 90-Tage-Reise, NICHT Sessions/Kurse, die er als Anbieter für andere anbietet (das ist der Business Hub). Das ist NICHT das Nutzerprofil — "meine Reise" bedeutet das Autopilot-Dashboard.',
    description = 'Dein Autopilot-Dashboard — die 90-Tage-Reise, die für dich vorbereitet wurde: Wellen, Meilensteine und empfohlene Aktionen, abgestimmt auf deinen Kalender. Es gibt zwei Ansichten, zwischen denen der Nutzer wechseln kann: die GEFÜHRTE Reise (die "Einführung", Schritt für Schritt, eine Session nach der anderen) und die VOLLVERSION (die volle App, alles auf einmal).',
    updated_at = NOW()
WHERE lang = 'de'
  AND catalog_id IN (SELECT id FROM nav_catalog WHERE screen_id = 'AUTOPILOT.MY_JOURNEY' AND tenant_id IS NULL);

-- Defense in depth: exact-phrase override triggers for the short, unambiguous
-- follow-up utterances (e.g. after Vitana offers "die Vollversion?" the user
-- just replies "Vollversion" or "Ja, die Vollversion"). These bypass fuzzy
-- scoring entirely on an exact normalized match — see
-- findOverrideTriggerMatch() in nav-catalog-db.ts. Merged (de-duplicated) with
-- any existing triggers; does not touch unrelated ones.
UPDATE nav_catalog c
SET override_triggers = (
      SELECT jsonb_agg(DISTINCT elem)
      FROM (
        SELECT elem FROM jsonb_array_elements(COALESCE(c.override_triggers, '[]'::jsonb)) AS elem
        UNION
        SELECT elem FROM jsonb_array_elements('[
             {"lang": "de", "phrase": "vollversion", "active": true},
             {"lang": "de", "phrase": "die vollversion", "active": true},
             {"lang": "de", "phrase": "einführung", "active": true},
             {"lang": "de", "phrase": "die einführung", "active": true},
             {"lang": "de", "phrase": "geführte reise", "active": true},
             {"lang": "en", "phrase": "vollversion", "active": true},
             {"lang": "en", "phrase": "guided journey", "active": true},
             {"lang": "en", "phrase": "full app", "active": true}
           ]'::jsonb) AS elem
      ) combined
    ),
    updated_at = NOW()
WHERE c.screen_id = 'AUTOPILOT.MY_JOURNEY'
  AND c.tenant_id IS NULL;

COMMIT;
