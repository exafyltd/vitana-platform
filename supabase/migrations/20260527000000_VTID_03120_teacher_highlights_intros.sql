-- VTID-03120 — Teacher highlights curriculum + locked intro scripts.
--
-- User feedback: the pedagogical curriculum order from VTID-03108 led
-- with foundational CONCEPTS (Five Pillars, Daily Loop, Vitana ID,
-- Did-You-Know). For first-week onboarding users those are abstract
-- and dry. The actual HIGHLIGHTS that get people engaged are the
-- POWERFUL capabilities — Life Compass setup, Vitana Index, Autopilot,
-- Daily Diary, Activity Match. Those need to come FIRST.
--
-- On top of that, the model has been ignoring the "3-4 sentence intro"
-- judgment rule in the system_instruction. Soft rules get lost in long
-- prompts. The same fix that worked for the wake-brief opener
-- (VTID-03104's `Say exactly:` deterministic pattern) is the answer
-- for intros too: store a hand-written, locked 3-4 sentence script
-- per capability in the DB, and the prompt tells the model to speak
-- it verbatim. Operators tune the scripts in the DB without a code
-- deploy. Capabilities without a populated script fall back to the
-- existing manual-based generation (with the soft 3-4 sentence rule
-- still in the prompt).
--
-- This migration:
--   1. Adds `teacher_intro_de TEXT` + `teacher_intro_en TEXT` columns.
--   2. Reorders `pedagogical_order` to put highlights first.
--   3. Seeds 3-4 sentence intros for the top 5 highlights in DE + EN.

ALTER TABLE system_capabilities
  ADD COLUMN IF NOT EXISTS teacher_intro_de TEXT;
ALTER TABLE system_capabilities
  ADD COLUMN IF NOT EXISTS teacher_intro_en TEXT;

COMMENT ON COLUMN system_capabilities.teacher_intro_de IS
  'VTID-03120: hand-written 3-4 sentence German intro the Teacher speaks verbatim via the Say-exactly pattern. NULL = fall back to manual-based generation in the Teacher Mode prompt.';
COMMENT ON COLUMN system_capabilities.teacher_intro_en IS
  'VTID-03120: hand-written 3-4 sentence English intro the Teacher speaks verbatim. NULL = fall back to manual-based generation.';

-- ============================================================
-- Step 1: reorder pedagogical_order
-- ============================================================
-- Highlights tier (10-50):
--   life_compass         — the ACTIONABLE setup that personalizes the system
--   vitana_index         — the daily measurement layer the user will see most
--   autopilot            — the agentic power the system has
--   diary_entry          — the daily capture habit that makes everything work
--   activity_match       — the community-matching power that turns it social
--
-- Voice highlight (60):
--   community_intent     — \"post an intent to find help / collaborate\"
--   community_post       — community share
--
-- Foundation tier (70-100):
--   five_pillars, journey_daily_loop, vitana_id, did_you_know, biomarkers
--
-- Advanced (110-200):
--   reminders, calendar_connect, scheduling, memory_garden, live_room,
--   invite_contact, events, marketplace
--
-- Capabilities without an explicit value here keep whatever they had.

UPDATE system_capabilities SET pedagogical_order = 10  WHERE capability_key = 'life_compass';
UPDATE system_capabilities SET pedagogical_order = 20  WHERE capability_key = 'vitana_index';
UPDATE system_capabilities SET pedagogical_order = 30  WHERE capability_key = 'autopilot';
UPDATE system_capabilities SET pedagogical_order = 40  WHERE capability_key = 'diary_entry';
UPDATE system_capabilities SET pedagogical_order = 50  WHERE capability_key = 'activity_match';

UPDATE system_capabilities SET pedagogical_order = 60  WHERE capability_key = 'community_intent';
UPDATE system_capabilities SET pedagogical_order = 70  WHERE capability_key = 'community_post';

UPDATE system_capabilities SET pedagogical_order = 80  WHERE capability_key = 'five_pillars';
UPDATE system_capabilities SET pedagogical_order = 90  WHERE capability_key = 'journey_daily_loop';
UPDATE system_capabilities SET pedagogical_order = 100 WHERE capability_key = 'vitana_id';
UPDATE system_capabilities SET pedagogical_order = 110 WHERE capability_key = 'did_you_know';
UPDATE system_capabilities SET pedagogical_order = 120 WHERE capability_key = 'biomarkers';

UPDATE system_capabilities SET pedagogical_order = 130 WHERE capability_key = 'reminders';
UPDATE system_capabilities SET pedagogical_order = 140 WHERE capability_key = 'calendar_connect';
UPDATE system_capabilities SET pedagogical_order = 150 WHERE capability_key = 'scheduling';
UPDATE system_capabilities SET pedagogical_order = 160 WHERE capability_key = 'memory_garden';

UPDATE system_capabilities SET pedagogical_order = 170 WHERE capability_key = 'events';
UPDATE system_capabilities SET pedagogical_order = 180 WHERE capability_key = 'live_room';
UPDATE system_capabilities SET pedagogical_order = 190 WHERE capability_key = 'invite_contact';
UPDATE system_capabilities SET pedagogical_order = 200 WHERE capability_key = 'marketplace';

-- ============================================================
-- Step 2: seed locked teacher_intro_* scripts for the top highlights
-- ============================================================
-- Voice + length notes:
--   - 3-4 spoken sentences per language
--   - Names the capability explicitly
--   - Explains WHAT, WHY (value to the user), HOW (where it shows up)
--   - For action-oriented capabilities (life_compass), invites the user to
--     SET IT UP together instead of just listening to an explanation
--   - Where appropriate, weaves in a trust / privacy reassurance — the
--     user has been explicit that this matters in onboarding
--   - Closes with a CTA the model can name the next capability after

-- life_compass — joint-setup framing. The first thing a new user should
-- do because everything else personalizes around it.
UPDATE system_capabilities
SET teacher_intro_de = 'Lass uns gleich gemeinsam deinen Life Compass einrichten — das ist das wichtigste Werkzeug, damit Vitana dich wirklich versteht. Du sagst mir kurz, was dir gerade im Leben am wichtigsten ist — zum Beispiel Gesundheit, Energie, eine bestimmte Beziehung oder ein Projekt — und ich verknüpfe das mit deinen Säulen, sodass jede spätere Empfehlung darauf abgestimmt ist. Wenn du dich später anders ausrichten möchtest, ändern wir das jederzeit — du bestimmst, ich folge. Magst du, dass wir das jetzt zusammen einrichten?',
    teacher_intro_en = 'Let''s set up your Life Compass together right now — it''s the single most important tool for Vitana to actually understand you. You tell me briefly what matters most to you in life right now — health, energy, a relationship, a project — and I tie that to your pillars so every later recommendation is tuned around it. Whenever you want to point in a different direction, we change it — you decide, I follow. Want to do it together now?'
WHERE capability_key = 'life_compass';

-- vitana_index — the daily measurement / dashboard layer
UPDATE system_capabilities
SET teacher_intro_de = 'Dein Vitana Index ist die tägliche Punktzahl, die zeigt, wie ausgewogen deine fünf Säulen gerade laufen — Ernährung, Hydration, Bewegung, Schlaf und Mentales. Du siehst ihn auf deinem Home-Screen, jeden Tag aktualisiert, und Vitana erklärt dir bei jedem Wert, welche Säule gerade trägt und welche ein wenig Aufmerksamkeit braucht. Alle Werte bleiben privat in deinem persönlichen Bereich — niemand sonst hat darauf Zugriff, und du entscheidest, was geteilt wird. Soll ich dir gleich zeigen, wie dein Index gerade aussieht?',
    teacher_intro_en = 'Your Vitana Index is the daily score that shows how balanced your five pillars are running — Nutrition, Hydration, Exercise, Sleep, and Mental. You see it on your home screen, updated every day, and Vitana explains at every reading which pillar is carrying you and which one needs a little attention. All values stay private in your personal space — no one else can see them, and you decide what gets shared. Want me to show you what your Index looks like right now?'
WHERE capability_key = 'vitana_index';

-- autopilot — agentic power, with a trust angle
UPDATE system_capabilities
SET teacher_intro_de = 'Der Autopilot ist das, was Vitana von einer App zu einem echten Partner macht — ich kann eigenständig Aufgaben für dich erledigen: Termine in deinen Kalender eintragen, Erinnerungen setzen, dir passende Menschen aus der Community vorschlagen, oder dir morgens ein kurzes Briefing zusammenstellen. Du gibst vor, was ich tun darf und was nicht — alles läuft mit deiner Zustimmung, und du siehst jeden Schritt im Verlauf. Nichts passiert hinter deinem Rücken, und du kannst den Autopiloten jederzeit anhalten oder anpassen. Magst du, dass ich dir zeige, wie du den Autopiloten startest?',
    teacher_intro_en = 'Autopilot is what turns Vitana from an app into an actual partner — I can take tasks off your shoulders: put events into your calendar, set reminders, suggest the right people from the community, or assemble a short morning briefing for you. You decide what I''m allowed to do and what stays off-limits — everything runs with your consent, and every step is visible in your history. Nothing happens behind your back, and you can pause or adjust Autopilot anytime. Want me to show you how to start it?'
WHERE capability_key = 'autopilot';

-- diary_entry — daily capture habit
UPDATE system_capabilities
SET teacher_intro_de = 'Dein Tagebuch ist der Ort, an dem du jeden Tag ganz kurz festhältst, wie es dir geht — was gut lief, was schwer war, was du gegessen, geschlafen oder gespürt hast. Vitana liest mit dir mit und zieht daraus die Muster, die deinen Index und deine Empfehlungen prägen — du musst nichts auswendig lernen, ich erinnere mich für dich. Deine Einträge gehören dir allein, sind verschlüsselt gespeichert, und nur du entscheidest, ob ein Auszug in eine Empfehlung einfließt. Soll ich dir gleich helfen, deinen ersten Eintrag von heute zu machen?',
    teacher_intro_en = 'Your Diary is where you briefly capture each day how you''re doing — what went well, what was hard, what you ate, slept, or felt. Vitana reads along with you and extracts the patterns that shape your Index and your recommendations — you don''t have to memorize anything, I remember for you. Your entries belong to you alone, are stored encrypted, and only you decide whether an excerpt flows into a recommendation. Want me to help you make your first entry for today right now?'
WHERE capability_key = 'diary_entry';

-- activity_match — community matching
UPDATE system_capabilities
SET teacher_intro_de = 'Activity Match ist Vitanas Weg, dich mit Menschen aus der Community zusammenzubringen, die gerade dasselbe vorhaben wie du — gemeinsam laufen, kochen, meditieren, einen Skill lernen, oder einfach reden. Du sagst mir, was du suchst, und ich gleiche es mit den offenen Absichten in der Community ab — du bekommst echte Vorschläge, keine zufällige Liste. Du entscheidest, ob und wann ein Match zu einem Kontakt wird — solange du nicht "Ja" sagst, bleibt deine Identität geschützt. Soll ich dir zeigen, wer gerade zu deinen Interessen passt?',
    teacher_intro_en = 'Activity Match is Vitana''s way of connecting you with people in the community who are up for the same thing as you right now — running together, cooking, meditating, learning a skill, or just talking. You tell me what you''re looking for, and I match it against the open intents in the community — you get real suggestions, not a random list. You decide whether and when a match turns into a contact — until you say yes, your identity stays protected. Want me to show you who matches your interests right now?'
WHERE capability_key = 'activity_match';

-- Index for the system_capabilities lookup. The teacher_intro_*
-- columns are read per-session by teacher-content-resolver.ts; no
-- index is needed (PK on capability_key already covers the lookup).
