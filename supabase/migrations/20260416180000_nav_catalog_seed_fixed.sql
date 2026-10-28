-- VTID-NAV-02 (re-issue 2026-04-16): idempotent nav_catalog seed.
-- The original 20260411000100_nav_catalog_seed.sql mistyped
-- related_kb_topics as text[] when the column is jsonb, so the whole
-- seed errored out on first INSERT and prod never got seeded.
-- This version fixes the literal to '[]'::jsonb and is otherwise identical.
BEGIN;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('e5307f20-3ae0-588e-8cb4-bff619a35877'::uuid, 'PUBLIC.LANDING', NULL, '/', 'public', 'public', TRUE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('e5307f20-3ae0-588e-8cb4-bff619a35877'::uuid, 'en', 'Vitanaland Landing', 'The main public entry point to Vitanaland and the Maxina community.', 'When the user wants to go back to the start, the landing page, the home page of the website, or hear the introduction again.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('e5307f20-3ae0-588e-8cb4-bff619a35877'::uuid, 'de', 'Vitanaland Startseite', 'Der öffentliche Haupteinstieg zu Vitanaland und der Maxina Community.', 'Wenn der Nutzer zurück zum Anfang, zur Startseite, zur Hauptseite der Website möchte oder die Einführung noch einmal hören will.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('d2c8571b-2b82-5d2d-b270-0c93b8da09af'::uuid, 'AUTH.MAXINA_PORTAL', NULL, '/maxina', 'auth', 'public', TRUE, 1, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('d2c8571b-2b82-5d2d-b270-0c93b8da09af'::uuid, 'en', 'Join the Maxina Community', 'Registration and sign-in for the Maxina community on Vitanaland.', 'When the user wants to register, sign up, join the community, create an account, or sign in to Maxina.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('d2c8571b-2b82-5d2d-b270-0c93b8da09af'::uuid, 'de', 'Der Maxina Community beitreten', 'Registrierung und Anmeldung für die Maxina Community auf Vitanaland.', 'Wenn der Nutzer sich registrieren, anmelden, der Community beitreten, ein Konto erstellen oder sich bei Maxina einloggen möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('be3a865a-0aad-5262-aeeb-28984a98a88c'::uuid, 'AUTH.ALKALMA_PORTAL', NULL, '/alkalma', 'auth', 'public', TRUE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('be3a865a-0aad-5262-aeeb-28984a98a88c'::uuid, 'en', 'Alkalma Portal', 'Registration and sign-in for the Alkalma tenant.', 'When the user mentions Alkalma specifically and wants to register or sign in.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('be3a865a-0aad-5262-aeeb-28984a98a88c'::uuid, 'de', 'Alkalma Portal', 'Registrierung und Anmeldung für den Alkalma Tenant.', 'Wenn der Nutzer Alkalma erwähnt und sich registrieren oder anmelden möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('2fa79e93-3fcc-545e-9d34-7efbc04875e5'::uuid, 'AUTH.EARTHLINKS_PORTAL', NULL, '/earthlinks', 'auth', 'public', TRUE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('2fa79e93-3fcc-545e-9d34-7efbc04875e5'::uuid, 'en', 'Earthlinks Portal', 'Registration and sign-in for the Earthlinks tenant.', 'When the user mentions Earthlinks specifically and wants to register or sign in.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('2fa79e93-3fcc-545e-9d34-7efbc04875e5'::uuid, 'de', 'Earthlinks Portal', 'Registrierung und Anmeldung für den Earthlinks Tenant.', 'Wenn der Nutzer Earthlinks erwähnt und sich registrieren oder anmelden möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('30f828c1-daf5-5562-a0b9-9f18e1c53816'::uuid, 'AUTH.GENERIC', NULL, '/auth', 'auth', 'public', TRUE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('30f828c1-daf5-5562-a0b9-9f18e1c53816'::uuid, 'en', 'Sign In', 'Generic sign-in and sign-up screen.', 'When the user wants a generic sign-in screen without a specific tenant context.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('30f828c1-daf5-5562-a0b9-9f18e1c53816'::uuid, 'de', 'Anmelden', 'Allgemeiner Anmelde- und Registrierungsbildschirm.', 'Wenn der Nutzer einen allgemeinen Anmeldebildschirm ohne spezifischen Tenant-Kontext möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('38fa0090-e7bb-513c-90e3-2e7756738db5'::uuid, 'PUBLIC.PRIVACY', NULL, '/privacy', 'public', 'public', TRUE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('38fa0090-e7bb-513c-90e3-2e7756738db5'::uuid, 'en', 'Privacy Policy', 'Public privacy policy page.', 'When the user asks about privacy, data protection, or what data Vitana collects.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('38fa0090-e7bb-513c-90e3-2e7756738db5'::uuid, 'de', 'Datenschutzerklärung', 'Öffentliche Datenschutzerklärung.', 'Wenn der Nutzer nach Datenschutz, Datenverarbeitung oder welche Daten Vitana sammelt fragt.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('3bab8e1f-3242-565f-bc1c-ff64ff85e5c2'::uuid, 'HOME.OVERVIEW', NULL, '/home', 'home', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('3bab8e1f-3242-565f-bc1c-ff64ff85e5c2'::uuid, 'en', 'Home', 'Your personal home dashboard with everything tailored for you.', 'When the user wants to go to their home page, the main dashboard, the start of the app after signing in.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('3bab8e1f-3242-565f-bc1c-ff64ff85e5c2'::uuid, 'de', 'Startseite', 'Dein persönliches Dashboard mit allem, was auf dich zugeschnitten ist.', 'Wenn der Nutzer zur eigenen Startseite, zum Hauptdashboard oder zum App-Start nach der Anmeldung möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('7f49193a-31ee-5c3c-a75c-ff5afbf47678'::uuid, 'HOME.MATCHES', NULL, '/home/matches', 'home', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('7f49193a-31ee-5c3c-a75c-ff5afbf47678'::uuid, 'en', 'Matches', 'People in the community who match your interests, goals, and values.', 'When the user asks who they should meet, who matches them, who to connect with, find friends, find people, find a partner, or discover compatible community members based on shared interests.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('7f49193a-31ee-5c3c-a75c-ff5afbf47678'::uuid, 'de', 'Matches', 'Menschen in der Community, die zu deinen Interessen, Zielen und Werten passen.', 'Wenn der Nutzer wissen will wen er treffen sollte, wer zu ihm passt, mit wem er sich verbinden kann, Freunde finden, Menschen finden, einen Partner finden, oder kompatible Community-Mitglieder anhand gemeinsamer Interessen entdecken.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('bf455900-3851-57c0-954c-8315ed4a466c'::uuid, 'HOME.AI_FEED', NULL, '/home/aifeed', 'home', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('bf455900-3851-57c0-954c-8315ed4a466c'::uuid, 'en', 'AI Feed', 'A personalized stream of AI-curated content, recommendations, and insights.', 'When the user asks what is new, what is happening, or wants to see their personalized AI-curated feed.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('bf455900-3851-57c0-954c-8315ed4a466c'::uuid, 'de', 'KI-Feed', 'Ein personalisierter Stream KI-kuratierter Inhalte, Empfehlungen und Einblicke.', 'Wenn der Nutzer fragt, was neu ist, was passiert, oder seinen personalisierten KI-Feed sehen möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('b4e8c9f6-68a7-53c3-b1a0-45218ecfb159'::uuid, 'COMM.OVERVIEW', NULL, '/comm', 'community', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('b4e8c9f6-68a7-53c3-b1a0-45218ecfb159'::uuid, 'en', 'Community', 'The Maxina community hub — events, live rooms, media, and groups.', 'When the user asks about the community in general, wants to explore community features, or is not sure where to look for social content.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('b4e8c9f6-68a7-53c3-b1a0-45218ecfb159'::uuid, 'de', 'Community', 'Der Maxina Community Hub — Events, Live-Räume, Medien und Gruppen.', 'Wenn der Nutzer allgemein nach der Community fragt, Community-Funktionen erkunden möchte oder nicht weiß, wo soziale Inhalte zu finden sind.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('f4e531c2-4b72-53c4-a051-1440d0ed11e0'::uuid, 'COMM.EVENTS', NULL, '/comm/events-meetups', 'community', 'authenticated', FALSE, 2, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('f4e531c2-4b72-53c4-a051-1440d0ed11e0'::uuid, 'en', 'Events & Meetups', 'Upcoming Maxina community events, in-person meetups, and gatherings.', 'When the user asks about upcoming events, meetups, things to attend, scheduled gatherings, dance events, wellness workshops, or community activities they can attend in person.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('f4e531c2-4b72-53c4-a051-1440d0ed11e0'::uuid, 'de', 'Events & Meetups', 'Kommende Maxina Community Events, persönliche Treffen und Zusammenkünfte.', 'Wenn der Nutzer nach kommenden Events, Meetups, Veranstaltungen, geplanten Treffen, Tanzveranstaltungen, Wellness-Workshops oder Community-Aktivitäten fragt, an denen teilgenommen werden kann.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('3f0c369d-e6ed-59f3-8efe-bdeccb8d8c31'::uuid, 'COMM.LIVE_ROOMS', NULL, '/comm/live-rooms', 'community', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('3f0c369d-e6ed-59f3-8efe-bdeccb8d8c31'::uuid, 'en', 'Live Rooms', 'Live audio and video rooms where community members gather in real time.', 'When the user asks about live rooms, live audio, live video, real-time conversations, online community calls, or virtual gatherings happening right now.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('3f0c369d-e6ed-59f3-8efe-bdeccb8d8c31'::uuid, 'de', 'Live-Räume', 'Live Audio- und Video-Räume, in denen sich Community-Mitglieder in Echtzeit treffen.', 'Wenn der Nutzer nach Live-Räumen, Live-Audio, Live-Video, Echtzeit-Gesprächen, Online-Community-Calls oder virtuellen Treffen fragt, die gerade stattfinden.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('d4f9ba66-1cf8-5aaa-a5be-63719728fa49'::uuid, 'COMM.MEDIA_HUB', NULL, '/comm/media-hub', 'community', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('d4f9ba66-1cf8-5aaa-a5be-63719728fa49'::uuid, 'en', 'Media Hub', 'Videos, podcasts, and music shared by the community.', 'When the user asks about videos, podcasts, music, recordings, or wants to browse media content from the community.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('d4f9ba66-1cf8-5aaa-a5be-63719728fa49'::uuid, 'de', 'Media Hub', 'Videos, Podcasts und Musik der Community.', 'Wenn der Nutzer nach Videos, Podcasts, Musik, Aufnahmen fragt oder Medieninhalte der Community durchstöbern möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('85374691-c4b7-5bf4-9baf-7a4d70e0ef1c'::uuid, 'BUSINESS.OVERVIEW', NULL, '/business', 'business', 'authenticated', FALSE, 1, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('85374691-c4b7-5bf4-9baf-7a4d70e0ef1c'::uuid, 'en', 'Business Hub', 'Your hub for building a business and earning income inside the Maxina community.', 'When the user asks about building a business, becoming a creator, becoming a service provider, or generally exploring how to monetize their skills in the Maxina community.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('85374691-c4b7-5bf4-9baf-7a4d70e0ef1c'::uuid, 'de', 'Business Hub', 'Dein Hub, um ein Business aufzubauen und in der Maxina Community Einkommen zu generieren.', 'Wenn der Nutzer fragt, wie man ein Business aufbaut, Creator wird, Dienstleister wird oder seine Fähigkeiten in der Maxina Community monetarisieren möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('fce8cf77-23fe-5816-b881-b64dc8b36d85'::uuid, 'BUSINESS.SERVICES', NULL, '/business/services', 'business', 'authenticated', FALSE, 1, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('fce8cf77-23fe-5816-b881-b64dc8b36d85'::uuid, 'en', 'My Services', 'Manage the services you offer to the Maxina community — coaching, classes, sessions, products.', 'When the user wants to manage their services, create a new service, list a coaching offering, or set up classes and sessions they offer.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('fce8cf77-23fe-5816-b881-b64dc8b36d85'::uuid, 'de', 'Meine Services', 'Verwalte die Services, die du der Maxina Community anbietest — Coaching, Kurse, Sessions, Produkte.', 'Wenn der Nutzer seine Services verwalten, einen neuen Service erstellen, ein Coaching-Angebot einstellen oder Kurse und Sessions einrichten möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('7013c375-7d90-5e26-a5ed-2e768b70cc4a'::uuid, 'BUSINESS.SELL_EARN', NULL, '/business/sell-earn', 'business', 'authenticated', FALSE, 2, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('7013c375-7d90-5e26-a5ed-2e768b70cc4a'::uuid, 'en', 'Sell & Earn', 'Build a new income stream by selling your services and earning rewards in the Maxina community.', 'When the user asks how to make money, earn income, build a side income, monetize their skills, monetize coaching, monetize fitness, monetize their expertise, sell services, become a paid creator, set up a new income stream, become a paid coach, or start earning from the Maxina community.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('7013c375-7d90-5e26-a5ed-2e768b70cc4a'::uuid, 'de', 'Verkaufen & Verdienen', 'Baue eine neue Einkommensquelle auf, indem du deine Services verkaufst und in der Maxina Community Belohnungen verdienst.', 'Wenn der Nutzer fragt wie man Geld verdient, Einkommen generiert, ein Nebeneinkommen aufbaut, seine Fähigkeiten monetarisiert, Coaching monetarisiert, Fitness monetarisiert, seine Expertise monetarisiert, Services verkauft, bezahlter Creator wird, eine neue Einkommensquelle aufbaut oder mit der Maxina Community Geld verdienen will.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('23ee8b4e-0de1-5a3e-9a33-b65894c091ce'::uuid, 'BUSINESS.CLIENTS', NULL, '/business/clients', 'business', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('23ee8b4e-0de1-5a3e-9a33-b65894c091ce'::uuid, 'en', 'My Clients', 'Manage the clients and customers of your Maxina business.', 'When the user asks about their clients, customers, who they serve, or how to manage client relationships in their business.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('23ee8b4e-0de1-5a3e-9a33-b65894c091ce'::uuid, 'de', 'Meine Kunden', 'Verwalte die Kunden deines Maxina Business.', 'Wenn der Nutzer nach seinen Kunden, Klienten, wen er bedient oder wie man Kundenbeziehungen im Business verwaltet, fragt.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('9b3e8c52-923c-5d8b-b7c7-934586f118b3'::uuid, 'BUSINESS.ANALYTICS', NULL, '/business/analytics', 'business', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('9b3e8c52-923c-5d8b-b7c7-934586f118b3'::uuid, 'en', 'Business Analytics', 'Performance metrics for your Maxina business — bookings, revenue, growth.', 'When the user asks about their business performance, revenue, bookings, growth metrics, or analytics for their services.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('9b3e8c52-923c-5d8b-b7c7-934586f118b3'::uuid, 'de', 'Business Analytics', 'Leistungskennzahlen für dein Maxina Business — Buchungen, Umsatz, Wachstum.', 'Wenn der Nutzer nach seiner Business-Performance, Umsatz, Buchungen, Wachstumskennzahlen oder Analytics für seine Services fragt.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('6cc471df-ba41-5af2-a311-42c076f5c701'::uuid, 'WALLET.OVERVIEW', NULL, '/wallet', 'wallet', 'authenticated', FALSE, 1, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('6cc471df-ba41-5af2-a311-42c076f5c701'::uuid, 'en', 'Wallet', 'Your Maxina wallet — balance, subscriptions, and rewards.', 'When the user asks to open their wallet, see their balance, check what they have, or generally explore the wallet area.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('6cc471df-ba41-5af2-a311-42c076f5c701'::uuid, 'de', 'Wallet', 'Dein Maxina Wallet — Guthaben, Abonnements und Belohnungen.', 'Wenn der Nutzer sein Wallet öffnen, seinen Kontostand sehen, prüfen will, was er hat, oder den Wallet-Bereich erkunden möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('d705e453-7344-5cfc-bad8-9eb78e471c8d'::uuid, 'WALLET.BALANCE', NULL, '/wallet/balance', 'wallet', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('d705e453-7344-5cfc-bad8-9eb78e471c8d'::uuid, 'en', 'Balance & Benefits', 'Your current Maxina balance and the benefits unlocked at your tier.', 'When the user asks about their balance, how much they have, their benefits, their tier, or what they have unlocked.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('d705e453-7344-5cfc-bad8-9eb78e471c8d'::uuid, 'de', 'Guthaben & Vorteile', 'Dein aktuelles Maxina Guthaben und die in deinem Tier freigeschalteten Vorteile.', 'Wenn der Nutzer nach seinem Guthaben, Kontostand, seinen Vorteilen, seinem Tier oder dem fragt, was er freigeschaltet hat.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('16a08da1-9227-5415-858a-7db4703ae022'::uuid, 'WALLET.SUBSCRIPTIONS', NULL, '/wallet/subscriptions', 'wallet', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('16a08da1-9227-5415-858a-7db4703ae022'::uuid, 'en', 'Subscriptions', 'Your active subscriptions and the services you are paying for.', 'When the user asks about their subscriptions, recurring payments, what they pay for, or wants to cancel or manage a subscription.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('16a08da1-9227-5415-858a-7db4703ae022'::uuid, 'de', 'Abonnements', 'Deine aktiven Abonnements und die Services, für die du bezahlst.', 'Wenn der Nutzer nach seinen Abonnements, wiederkehrenden Zahlungen, wofür er bezahlt fragt oder ein Abonnement kündigen oder verwalten möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('c9abcd62-59cd-5266-bbfb-5b393632b9e8'::uuid, 'WALLET.REWARDS', NULL, '/wallet/rewards', 'wallet', 'authenticated', FALSE, 2, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('c9abcd62-59cd-5266-bbfb-5b393632b9e8'::uuid, 'en', 'Rewards & Commissions', 'Commissions and rewards you have earned from sharing the platform and serving clients.', 'When the user asks about commissions, referral earnings, rewards, payouts, what they have earned, or how much they have made from sharing or selling in the community.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('c9abcd62-59cd-5266-bbfb-5b393632b9e8'::uuid, 'de', 'Belohnungen & Provisionen', 'Provisionen und Belohnungen, die du durch das Teilen der Plattform und das Betreuen von Kunden verdient hast.', 'Wenn der Nutzer nach Provisionen, Empfehlungseinnahmen, Belohnungen, Auszahlungen, wieviel er verdient hat oder wieviel er durch Teilen oder Verkaufen in der Community gemacht hat, fragt.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('70c24bd7-5612-5bac-8edd-c71d732635b7'::uuid, 'HEALTH.OVERVIEW', NULL, '/health', 'health', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('70c24bd7-5612-5bac-8edd-c71d732635b7'::uuid, 'en', 'Health', 'Your personal health hub — biology, plans, and education.', 'When the user asks about their health in general, longevity, wellness, or wants to explore health features.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('70c24bd7-5612-5bac-8edd-c71d732635b7'::uuid, 'de', 'Gesundheit', 'Dein persönlicher Gesundheits-Hub — Biologie, Pläne und Bildung.', 'Wenn der Nutzer allgemein nach seiner Gesundheit, Longevity, Wellness fragt oder Gesundheitsfunktionen erkunden möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('73f1f5c6-bb8a-55e2-a175-e9e75e0cdbd7'::uuid, 'HEALTH.MY_BIOLOGY', NULL, '/health/my-biology', 'health', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('73f1f5c6-bb8a-55e2-a175-e9e75e0cdbd7'::uuid, 'en', 'My Biology', 'Track your biomarkers, lab results, and personal health indicators with trends over time.', 'When the user asks about their biology, biomarkers, lab results, blood work, health indicators, body composition, or wants to track their personal health data and trends.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('73f1f5c6-bb8a-55e2-a175-e9e75e0cdbd7'::uuid, 'de', 'Meine Biologie', 'Verfolge deine Biomarker, Laborergebnisse und persönlichen Gesundheitsindikatoren mit Trends über die Zeit.', 'Wenn der Nutzer nach seiner Biologie, Biomarkern, Laborergebnissen, Blutwerten, Gesundheitsindikatoren, Körperzusammensetzung fragt oder seine persönlichen Gesundheitsdaten und Trends verfolgen möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('12eb827f-95f1-5fb0-bda9-d9ca2aba85cb'::uuid, 'HEALTH.PLANS', NULL, '/health/plans', 'health', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('12eb827f-95f1-5fb0-bda9-d9ca2aba85cb'::uuid, 'en', 'My Plans', 'Personalized health plans built around your goals — nutrition, fitness, sleep, stress.', 'When the user asks about their health plans, their nutrition plan, their fitness plan, their personal program, or what they should be doing for their goals.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('12eb827f-95f1-5fb0-bda9-d9ca2aba85cb'::uuid, 'de', 'Meine Pläne', 'Personalisierte Gesundheitspläne rund um deine Ziele — Ernährung, Fitness, Schlaf, Stress.', 'Wenn der Nutzer nach seinen Gesundheitsplänen, seinem Ernährungsplan, seinem Fitnessplan, seinem persönlichen Programm oder dem, was er für seine Ziele tun sollte, fragt.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('7f58a662-9529-568e-bbda-4db88d883fda'::uuid, 'HEALTH.EDUCATION', NULL, '/health/education', 'health', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('7f58a662-9529-568e-bbda-4db88d883fda'::uuid, 'en', 'Education & Science', 'Health education content and longevity science from the Vitana knowledge base.', 'When the user asks to learn about a health topic, wants to read about longevity science, or wants educational content on wellness.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('7f58a662-9529-568e-bbda-4db88d883fda'::uuid, 'de', 'Bildung & Wissenschaft', 'Gesundheitsbildung und Longevity-Wissenschaft aus der Vitana Knowledge Base.', 'Wenn der Nutzer ein Gesundheitsthema lernen möchte, über Longevity-Wissenschaft lesen will oder Bildungsinhalte zu Wellness sucht.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('81019d74-0860-5cee-a613-a9b59bba5561'::uuid, 'HEALTH.SERVICES_HUB', NULL, '/health/services-hub', 'health', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('81019d74-0860-5cee-a613-a9b59bba5561'::uuid, 'en', 'Health Services Hub', 'Find and book health services from providers in the Maxina community.', 'When the user asks where to find health services, how to book a session with a practitioner, or wants to browse health professionals.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('81019d74-0860-5cee-a613-a9b59bba5561'::uuid, 'de', 'Health Services Hub', 'Finde und buche Gesundheitsdienstleistungen von Anbietern in der Maxina Community.', 'Wenn der Nutzer fragt, wo er Gesundheitsdienstleistungen findet, wie er eine Sitzung mit einem Praktiker bucht oder Gesundheitsfachleute durchstöbern möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('cb93317e-9dda-505e-a177-0d8d5ee331e4'::uuid, 'DISCOVER.OVERVIEW', NULL, '/discover', 'discover', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('cb93317e-9dda-505e-a177-0d8d5ee331e4'::uuid, 'en', 'Discover', 'Browse supplements, wellness services, doctors, deals, and more.', 'When the user wants to browse, discover, or shop for products and services in the Maxina marketplace.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('cb93317e-9dda-505e-a177-0d8d5ee331e4'::uuid, 'de', 'Entdecken', 'Durchstöbere Nahrungsergänzungsmittel, Wellness-Services, Ärzte, Angebote und mehr.', 'Wenn der Nutzer Produkte und Services im Maxina Marktplatz durchstöbern, entdecken oder kaufen möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('3483e0e8-770b-5021-8d5c-ccc559a4a65e'::uuid, 'DISCOVER.SUPPLEMENTS', NULL, '/discover/supplements', 'discover', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('3483e0e8-770b-5021-8d5c-ccc559a4a65e'::uuid, 'en', 'Supplements', 'Curated supplements for longevity and wellness.', 'When the user asks about supplements, vitamins, minerals, nutraceuticals, or what to take for their health.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('3483e0e8-770b-5021-8d5c-ccc559a4a65e'::uuid, 'de', 'Nahrungsergänzungsmittel', 'Kuratierte Nahrungsergänzungsmittel für Longevity und Wellness.', 'Wenn der Nutzer nach Nahrungsergänzungsmitteln, Vitaminen, Mineralien, Nutraceuticals oder dem, was er für seine Gesundheit nehmen sollte, fragt.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('17100496-7f04-51d3-8932-b2f8584ce3f5'::uuid, 'DISCOVER.WELLNESS_SERVICES', NULL, '/discover/wellness-services', 'discover', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('17100496-7f04-51d3-8932-b2f8584ce3f5'::uuid, 'en', 'Wellness Services', 'Wellness services offered by the Maxina community.', 'When the user asks about wellness services, massage, spa, recovery, or treatments they can book.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('17100496-7f04-51d3-8932-b2f8584ce3f5'::uuid, 'de', 'Wellness-Services', 'Wellness-Services, die von der Maxina Community angeboten werden.', 'Wenn der Nutzer nach Wellness-Services, Massage, Spa, Recovery oder Behandlungen fragt, die er buchen kann.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('dcc8f661-6400-5ef1-83c5-42b7d722b504'::uuid, 'DISCOVER.DOCTORS_COACHES', NULL, '/discover/doctors-coaches', 'discover', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('dcc8f661-6400-5ef1-83c5-42b7d722b504'::uuid, 'en', 'Doctors & Coaches', 'Find doctors, coaches, and health practitioners.', 'When the user asks about doctors, coaches, practitioners, specialists, or wants to find a health professional.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('dcc8f661-6400-5ef1-83c5-42b7d722b504'::uuid, 'de', 'Ärzte & Coaches', 'Finde Ärzte, Coaches und Gesundheitspraktiker.', 'Wenn der Nutzer nach Ärzten, Coaches, Praktikern, Spezialisten fragt oder einen Gesundheitsfachmann finden möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('3c5fb4a9-0fb4-521d-b6c8-824faf9fb5bd'::uuid, 'DISCOVER.DEALS', NULL, '/discover/deals-offers', 'discover', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('3c5fb4a9-0fb4-521d-b6c8-824faf9fb5bd'::uuid, 'en', 'Deals & Offers', 'Member deals, discounts, and special offers.', 'When the user asks about deals, discounts, offers, promotions, or what is on sale.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('3c5fb4a9-0fb4-521d-b6c8-824faf9fb5bd'::uuid, 'de', 'Angebote & Deals', 'Mitgliederangebote, Rabatte und spezielle Aktionen.', 'Wenn der Nutzer nach Angeboten, Rabatten, Promotionen oder dem, was im Sale ist, fragt.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('469ac396-8547-5ff9-b8ab-8b873eb0f969'::uuid, 'MEMORY.OVERVIEW', NULL, '/memory', 'memory', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('469ac396-8547-5ff9-b8ab-8b873eb0f969'::uuid, 'en', 'Memory Garden', 'Your personal memory — everything Vitana remembers about you.', 'When the user asks about their Memory Garden, what Vitana remembers about them, their personal records, or wants to manage their memory.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('469ac396-8547-5ff9-b8ab-8b873eb0f969'::uuid, 'de', 'Memory Garden', 'Dein persönliches Gedächtnis — alles, was Vitana über dich weiß.', 'Wenn der Nutzer nach seinem Memory Garden, dem was Vitana über ihn weiß, seinen persönlichen Aufzeichnungen fragt oder sein Gedächtnis verwalten möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('b4c1e075-e37d-51b2-991e-0140cff26a04'::uuid, 'MEMORY.DIARY', NULL, '/memory/diary', 'memory', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('b4c1e075-e37d-51b2-991e-0140cff26a04'::uuid, 'en', 'Daily Diary', 'Your daily diary entries — log thoughts, moods, and reflections.', 'When the user asks to write a diary entry, log how they feel, journal their day, or open their daily diary.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('b4c1e075-e37d-51b2-991e-0140cff26a04'::uuid, 'de', 'Tagesbuch', 'Deine täglichen Tagebucheinträge — halte Gedanken, Stimmungen und Reflexionen fest.', 'Wenn der Nutzer einen Tagebucheintrag schreiben, festhalten wie er sich fühlt, seinen Tag journaling oder sein Tagebuch öffnen möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('52e8358b-0794-5cb2-ac33-d0ca17c12452'::uuid, 'AI.COMPANION', NULL, '/ai/companion', 'ai', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('52e8358b-0794-5cb2-ac33-d0ca17c12452'::uuid, 'en', 'AI Companion', 'Chat with Vitana in a focused companion view.', 'When the user wants to open the dedicated Vitana chat, the AI companion view, or have an extended conversation outside the orb.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('52e8358b-0794-5cb2-ac33-d0ca17c12452'::uuid, 'de', 'KI-Begleiter', 'Chatte mit Vitana in einer fokussierten Begleiter-Ansicht.', 'Wenn der Nutzer den dedizierten Vitana-Chat, die KI-Begleiter-Ansicht öffnen oder eine längere Unterhaltung außerhalb des Orbs führen möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('b0868bda-8a81-5216-a5ac-34d10cc55db9'::uuid, 'AI.RECOMMENDATIONS', NULL, '/ai/recommendations', 'ai', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('b0868bda-8a81-5216-a5ac-34d10cc55db9'::uuid, 'en', 'Recommendations', 'Personalized AI recommendations across health, community, and content.', 'When the user asks for recommendations, suggestions, what they should do, or wants to see Vitana''s personalized picks for them.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('b0868bda-8a81-5216-a5ac-34d10cc55db9'::uuid, 'de', 'Empfehlungen', 'Personalisierte KI-Empfehlungen für Gesundheit, Community und Inhalte.', 'Wenn der Nutzer nach Empfehlungen, Vorschlägen fragt, was er tun sollte, oder Vitanas personalisierte Auswahl für ihn sehen möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('e0194c6c-9b04-5878-b93a-fa70acae988e'::uuid, 'INBOX.OVERVIEW', NULL, '/inbox', 'inbox', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('e0194c6c-9b04-5878-b93a-fa70acae988e'::uuid, 'en', 'Inbox', 'Messages, reminders, and inspiration delivered to you.', 'When the user asks about their inbox, messages, notifications, or wants to check what has been sent to them.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('e0194c6c-9b04-5878-b93a-fa70acae988e'::uuid, 'de', 'Posteingang', 'Nachrichten, Erinnerungen und Inspiration, die dir zugestellt wurden.', 'Wenn der Nutzer nach seinem Posteingang, Nachrichten, Benachrichtigungen fragt oder sehen möchte, was ihm gesendet wurde.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('6f65b09e-f352-5420-8b54-014607826d84'::uuid, 'INBOX.REMINDERS', NULL, '/inbox/reminder', 'inbox', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('6f65b09e-f352-5420-8b54-014607826d84'::uuid, 'en', 'Reminders', 'Reminders Vitana has set for you.', 'When the user asks about their reminders, what Vitana has reminded them about, or wants to see scheduled prompts.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('6f65b09e-f352-5420-8b54-014607826d84'::uuid, 'de', 'Erinnerungen', 'Erinnerungen, die Vitana für dich gesetzt hat.', 'Wenn der Nutzer nach seinen Erinnerungen fragt, woran Vitana ihn erinnert hat oder geplante Hinweise sehen möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('f77d1927-c8fd-514b-b075-0bbf4b1023d6'::uuid, 'SETTINGS.OVERVIEW', NULL, '/settings', 'settings', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('f77d1927-c8fd-514b-b075-0bbf4b1023d6'::uuid, 'en', 'Settings', 'Your account settings and preferences.', 'When the user asks to open their settings, change preferences, or manage their account.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('f77d1927-c8fd-514b-b075-0bbf4b1023d6'::uuid, 'de', 'Einstellungen', 'Deine Kontoeinstellungen und Präferenzen.', 'Wenn der Nutzer seine Einstellungen öffnen, Präferenzen ändern oder sein Konto verwalten möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('2946fd3f-c652-5181-a375-e3960590b5d4'::uuid, 'SETTINGS.PRIVACY', NULL, '/settings/privacy', 'settings', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('2946fd3f-c652-5181-a375-e3960590b5d4'::uuid, 'en', 'Privacy Settings', 'Manage what data Vitana stores and what is shared with the community.', 'When the user asks about privacy settings, data control, what is shared, consent, or wants to change their privacy preferences.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('2946fd3f-c652-5181-a375-e3960590b5d4'::uuid, 'de', 'Datenschutzeinstellungen', 'Verwalte, welche Daten Vitana speichert und was mit der Community geteilt wird.', 'Wenn der Nutzer nach Datenschutzeinstellungen, Datenkontrolle, was geteilt wird, Einwilligung fragt oder seine Datenschutzpräferenzen ändern möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog (id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active)
VALUES ('fb65d40b-f2b8-5b23-a31a-0df35c6b22c6'::uuid, 'SETTINGS.NOTIFICATIONS', NULL, '/settings/notifications', 'settings', 'authenticated', FALSE, 0, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET route = EXCLUDED.route, category = EXCLUDED.category, access = EXCLUDED.access, anonymous_safe = EXCLUDED.anonymous_safe, priority = EXCLUDED.priority, related_kb_topics = EXCLUDED.related_kb_topics, is_active = TRUE;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('fb65d40b-f2b8-5b23-a31a-0df35c6b22c6'::uuid, 'en', 'Notifications', 'Manage your notification preferences.', 'When the user asks about notification settings, push notifications, email alerts, or wants to turn notifications on or off.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit)
VALUES ('fb65d40b-f2b8-5b23-a31a-0df35c6b22c6'::uuid, 'de', 'Benachrichtigungen', 'Verwalte deine Benachrichtigungspräferenzen.', 'Wenn der Nutzer nach Benachrichtigungseinstellungen, Push-Benachrichtigungen, E-Mail-Hinweisen fragt oder Benachrichtigungen ein- oder ausschalten möchte.')
ON CONFLICT (catalog_id, lang) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, when_to_visit = EXCLUDED.when_to_visit;

COMMIT;
