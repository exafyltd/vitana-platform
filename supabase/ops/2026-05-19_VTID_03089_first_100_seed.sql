-- =============================================================================
-- VTID-03089 — Seed "🎆 FIRST 100" group + Vitana welcome + 1,876 hello backfill
-- =============================================================================
--
-- Idempotent: safe to re-run. Specifically:
--   * chat_groups insert is guarded by an existence check on (tenant_id, name).
--   * chat_group_members insert uses ON CONFLICT DO NOTHING.
--   * Vitana welcome is gated on metadata source uniqueness.
--   * Welcome-chat backfill respects app_users.welcome_chat_sent.
--
-- Cutoff for the hello-message backfill: midnight 2026-05-19 CET == today's
-- registrations only (2026-05-18T22:00:00Z UTC start).
-- =============================================================================

BEGIN;

-- a) Create the FIRST 100 group (idempotent).
INSERT INTO public.chat_groups (tenant_id, name, description, is_system, metadata)
SELECT
  '2e7528b8-472a-4356-88da-0280d4639cce'::uuid,
  '🎆 FIRST 100',
  'Maxina Longevity Community — die ersten 100 Mitglieder. 30-Tage-Testgruppe vor dem Launch.',
  true,
  jsonb_build_object('seeded_by', 'VTID-03089', 'cap', 100)
WHERE NOT EXISTS (
  SELECT 1 FROM public.chat_groups
   WHERE tenant_id = '2e7528b8-472a-4356-88da-0280d4639cce'::uuid
     AND name = '🎆 FIRST 100'
);

-- b) Add the Vitana bot first (so it's role='bot') + every primary tenant
--    member next, up to the 100 cap. ON CONFLICT keeps re-runs safe.
WITH g AS (
  SELECT id, tenant_id FROM public.chat_groups
   WHERE tenant_id = '2e7528b8-472a-4356-88da-0280d4639cce'::uuid
     AND name = '🎆 FIRST 100'
),
candidates AS (
  SELECT g.id AS group_id, g.tenant_id,
         '00000000-0000-0000-0000-000000000001'::uuid AS user_id,
         'bot' AS role,
         0 AS seq
  FROM g
  UNION ALL
  SELECT g.id, g.tenant_id, ut.user_id, 'member',
         row_number() OVER (ORDER BY ut.user_id)
  FROM g
  JOIN public.user_tenants ut
    ON ut.tenant_id = g.tenant_id
   AND ut.is_primary = true
   AND ut.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
)
INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role)
SELECT group_id, user_id, tenant_id, role
FROM candidates
WHERE seq < 100
ON CONFLICT (group_id, user_id) DO NOTHING;

-- c) Vitana's German welcome message (only if not already posted).
INSERT INTO public.chat_messages
  (tenant_id, sender_id, receiver_id, group_id, content, message_type, metadata)
SELECT
  g.tenant_id,
  '00000000-0000-0000-0000-000000000001'::uuid,
  NULL,
  g.id,
  $welcome$Hallo meine lieben FIRST 100! Herzlich Willkommen in der Maxina Longevity Community!
Vielen Dank, dass du die Maxina App installiert und unserer exklusiven 30-Tage-Testgruppe beigetreten bist.

Du gehörst jetzt zu den ersten 100 Mitgliedern, die uns helfen, die Zukunft von Vitanaland und der Maxina App vor dem offiziellen Launch mitzugestalten.

Als Dankeschön für deine Unterstützung erhältst du:

- Ein kostenloses 1-Jahres-Maxina-Abo im Wert von 99 EUR
- Ein kostenloses Ticket für eine unserer Maxina Experience Mallorca Events ebenfalls im Wert von 99 EUR
- Zusätzliche Geschenke und Belohnungen während der Testphase für aktive Teilnahme und hilfreiches Feedback

Unser Ziel ist einfach:

Vitana wird entwickelt, um Menschen dabei zu helfen, ihre Gesundheit, Lebensqualität, Beziehungen und den Alltag zu verbessern — mit weniger Stress, weniger Verwirrung und mehr Unterstützung.

Lass Vitana das Denken und die Arbeit für uns erledigen.

---

Deine 30-Tage-Testphase
Die Testphase beginnt am 19. Mai 2026 und endet mit unserem offiziellen Launch am 18. Juni 2026.

Die einzige Bedingung ist einfach:
Bitte melde dich einmal pro Tag an oder nutze die App.

Und keine Sorge — du musst dir nicht merken, was du testen sollst.
Wir senden dir jeden Tag eine kurze Nachricht mit genau dem, was wir dir gerne zum Ausprobieren vorschlagen.

---

Vitana ist Voice-First

Das bedeutet, dass du nicht durch komplizierte Menüs suchen oder lange überlegen musst, wo du klicken musst.
Drück einfach die ORB und sprich mit Vitana per Sprachsteuerung.
Sprich ganz natürlich, wie du mit einer hilfreichen Person sprechen würdest.
Zum Beispiel kannst du sagen:

- „Vitana, hilf mir."
- „Was ist das?"
- „Wie mache ich das?"
- „Wer ist in der Community?"
- „Öffne mein Tagebuch."
- „Zeig meinen Vitana Index."
- „Öffne meinen Lebenskompass."
- „Finde einen Match."
- „Finde Events und Treffen."
- „Sprich mit dem technischen Support."
- „Sende eine Chat-Nachricht."
- „Setze eine Erinnerung."
- „Verwalte meinen Kalender."
- „Verbinde meine Apps und Wearables."
- „Öffne meine Smart Wallet."
- „Starte den Autopiloten."

Alles beginnt mit Bewusstsein.
Miss deine Gesundheit.
Weniger nachdenken. Mehr tun.
Lass Vitana es für dich erledigen.

---

Welches Feedback uns am meisten hilft
Während dieser Testphase ist unsere oberste Priorität, Fehler zu finden und zu beheben.
Dazu gehören Dinge wie:

- Knöpfe, die nicht funktionieren
- Falsche Weiterleitungen
- Falsche Informationen
- Übersetzungsprobleme
- Funktionen, die sich unerwartet verhalten
- Alles, was verwirrend, störend, irritierend oder anders als erwartet ist

Jedes einzelne Feedback hilft uns, die Plattform zu verbessern.

---

Feedback zu geben ist einfach
Du kannst alles ganz einfach per Sprache an Devon, unseren KI-Technik-Support, melden.

Sag einfach zu Vitana:

„Ich möchte mit Devon sprechen"
oder
„Ich möchte den Kundensupport sprechen"

Du kannst auch manuell im Bug Report Bildschirm auf die Mikrofon-Taste tippen und sprichst dein Feedback einfach ein.

Dein Bericht erreicht automatisch unser Team.

Nochmals vielen Dank, dass du von Anfang an Teil dieser Reise bist.
Wir freuen uns sehr darauf, diese Erfahrung gemeinsam mit dir zu erleben.
Herzliche Grüße,
Eure Vitana$welcome$,
  'text',
  jsonb_build_object(
    'source', 'vitana_group_welcome',
    'automated', true,
    'group_name', '🎆 FIRST 100',
    'language', 'de',
    'seeded_by', 'VTID-03089'
  )
FROM public.chat_groups g
WHERE g.tenant_id = '2e7528b8-472a-4356-88da-0280d4639cce'::uuid
  AND g.name = '🎆 FIRST 100'
  AND NOT EXISTS (
    SELECT 1 FROM public.chat_messages cm
    WHERE cm.group_id = g.id
      AND cm.metadata->>'source' = 'vitana_group_welcome'
  );

-- d) 1,876-message hello backfill — every user registered after midnight
--    2026-05-19 CET sends "Hello! My name is <name> — ..." to every other
--    tenant member (incl. the other new arrivals; excluding the bot and self).
WITH cutoff AS (SELECT '2026-05-18T22:00:00Z'::timestamptz AS since),
new_users AS (
  SELECT u.user_id, u.display_name, ut.tenant_id
  FROM public.app_users u
  JOIN public.user_tenants ut
    ON ut.user_id = u.user_id
   AND ut.is_primary = true
  WHERE u.created_at >= (SELECT since FROM cutoff)
    AND COALESCE(u.welcome_chat_sent, false) = false
    AND u.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
),
qualifying AS (
  SELECT nu.user_id, nu.display_name, nu.tenant_id,
    (SELECT COUNT(*) FROM public.user_tenants ut3
      WHERE ut3.tenant_id = nu.tenant_id
        AND ut3.user_id <> nu.user_id
        AND ut3.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
    ) AS member_count
  FROM new_users nu
),
recipients AS (
  SELECT
    q.user_id AS sender_id,
    q.tenant_id,
    COALESCE(NULLIF(TRIM(q.display_name), ''), 'a new member') AS name,
    ut.user_id AS receiver_id
  FROM qualifying q
  JOIN public.user_tenants ut ON ut.tenant_id = q.tenant_id
  WHERE q.member_count BETWEEN 1 AND 1000
    AND ut.user_id <> q.user_id
    AND ut.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
),
inserted AS (
  INSERT INTO public.chat_messages
    (tenant_id, sender_id, receiver_id, content, message_type, metadata)
  SELECT
    tenant_id,
    sender_id,
    receiver_id,
    'Hello! My name is ' || name || ' — I just joined the community and I''m excited to connect with you! 🙌',
    'text',
    jsonb_build_object(
      'source', 'welcome_chat',
      'automated', true,
      'backfill', true,
      'backfill_run', '2026-05-19',
      'seeded_by', 'VTID-03089'
    )
  FROM recipients
  RETURNING sender_id
),
inserted_summary AS (
  SELECT sender_id, COUNT(*) AS n FROM inserted GROUP BY sender_id
)
UPDATE public.app_users
SET welcome_chat_sent = true
WHERE user_id IN (SELECT sender_id FROM inserted_summary);

COMMIT;

-- Final tally for the workflow log.
SELECT
  (SELECT COUNT(*) FROM public.chat_groups WHERE name = '🎆 FIRST 100') AS group_rows,
  (SELECT COUNT(*) FROM public.chat_group_members
     WHERE group_id IN (SELECT id FROM public.chat_groups WHERE name = '🎆 FIRST 100')
  ) AS members_now,
  (SELECT COUNT(*) FROM public.chat_messages
     WHERE metadata->>'source' = 'vitana_group_welcome'
  ) AS vitana_welcomes,
  (SELECT COUNT(*) FROM public.chat_messages
     WHERE metadata->>'backfill_run' = '2026-05-19'
  ) AS hello_backfill_rows;
