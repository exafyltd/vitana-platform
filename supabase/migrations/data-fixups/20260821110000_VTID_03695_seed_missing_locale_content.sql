-- VTID-03695 — close the DB-content parity gaps on the two localized surfaces.
--
-- WHAT WAS BROKEN
--
-- Six GA locales were short of the `en` reference in `nav_catalog_i18n`
-- (es -10, fr -15, pl -5, pt -10, ru -2, sr -5 = 47 rows) and seven locales
-- were missing topic T178 in `journey_checklist_translations`.
--
-- A GA locale with partial DB content does not fail — it renders GERMAN inside
-- an otherwise translated UI, with no error anywhere. That is the VTID-03519
-- failure, and `ci_vital_systems_health()` (VTID-03666) reports it every
-- morning but cannot repair it.
--
-- WHY A MIGRATION RATHER THAN `seed-db-i18n.ts`
--
-- The seeder is the intended path and remains so. It could not be used to
-- produce this fix, for a reason worth recording because it is still true
-- after this migration lands:
--
--   `planWork()` compares source units against the JSON ARTIFACT under
--   `data/db-i18n/`, never against the database. That directory is EMPTY —
--   the artifact system was built by VTID-03515 but never populated. So a
--   plain `--apply` run classifies all ~545 source units as `missing` for
--   every target locale (~4,400 units) and re-translates the entire corpus,
--   overwriting ~1,700 good existing translations to fix 54 gaps.
--
-- Backfilling the artifacts from the DB is the real repair, and it is filed
-- as a follow-up rather than done here: the DB's own `source_sha` column
-- cannot be copied into the artifacts verbatim (see the note below), so the
-- backfill needs a script run where credentials exist, not a SQL file.
--
-- A NOTE ON `source_sha` — MEASURED, NOT ASSUMED
--
-- The `source_sha` values already stored on translated rows do NOT reproduce
-- under `sourceSha()` (services/db-i18n/surfaces.ts): sha1 over
-- `order.map(f => `${f} ${fields[f]}`).join('')`, first 16 hex.
--
--   * Verified the formula implementation agrees between SQL (pgcrypto) and
--     Node — both yield 40b9363b3fd75e3f for catalog 003c68a2 where the
--     stored stamp is aeba7587fe4420ad.
--   * Brute-forced field order, separators, label styles, sha1/sha256/md5 and
--     both possible sources (de and the en pivot). Nothing reproduces it.
--   * It is not a hash of the translation either.
--   * It is source-derived: all six locales carry the IDENTICAL stamp per
--     catalog entry.
--   * It is not staleness. Per row, ZERO translated rows have a `de` row
--     edited after them — the translations post-date the source everywhere.
--
-- So the stored stamps are legacy-format and unreproducible, but they are NOT
-- currently causing a bug: `planWork` reads the artifact, not this column.
-- Rows inserted here are therefore stamped with the CORRECT current-format
-- sha computed from live German source, which is strictly better than
-- propagating an unreproducible one.
--
-- T178 is the exception and is deliberately left NULL: its `en` and `es`
-- siblings both carry NULL, so a stamp here would be the only one of its kind
-- and would misreport that unit as verified.
--
-- IDEMPOTENT. Every statement is ON CONFLICT DO NOTHING, so re-running repairs
-- only what is still missing and never overwrites a human correction.

BEGIN;

-- pgcrypto provides digest(); already present on this project, kept for a
-- rebuilt database where it may not be.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The current-format source fingerprint, mirroring sourceSha() exactly.
CREATE OR REPLACE FUNCTION pg_temp.nav_source_sha(
  p_title text, p_description text, p_when_to_visit text
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT substr(
    encode(
      digest(
        'title ' || coalesce(p_title, '') ||
        'description ' || coalesce(p_description, '') ||
        'when_to_visit ' || coalesce(p_when_to_visit, ''),
        'sha1'
      ), 'hex'
    ), 1, 16);
$$;

-- ---------------------------------------------------------------------------
-- PART A — 18 rows filled from a SIBLING entry, no translation involved.
--
-- The nav catalog contains duplicate entries: distinct catalog_ids whose
-- German source text is byte-identical ("Shorts", "Podcasts", "Support",
-- "Inspiration", "Abonnements"). Where such a twin already has a translation
-- in the target locale, copying it is not a shortcut — it is the only answer
-- that keeps the two entries consistent.
--
-- That consistency is already broken where these were translated
-- independently: pl has BOTH "Inspiracje" and "Inspiracja", and sr has BOTH
-- "Podcasti" and "Podkasti", for byte-identical German. Copying prevents
-- adding a third variant; it does not repair the existing two (out of scope —
-- picking a winner is a native-reviewer call, filed as a follow-up).
-- ---------------------------------------------------------------------------

WITH de AS (
  SELECT catalog_id, title, description, when_to_visit
  FROM nav_catalog_i18n WHERE lang = 'de'
),
targets AS (SELECT code FROM supported_locales WHERE code IN ('es','fr','pl','pt','ru','sr')),
gaps AS (
  SELECT c.id AS catalog_id, t.code AS lang
  FROM nav_catalog c
  CROSS JOIN targets t
  WHERE c.is_active = true
    AND EXISTS (SELECT 1 FROM nav_catalog_i18n e WHERE e.catalog_id = c.id AND e.lang = 'en')
    AND NOT EXISTS (SELECT 1 FROM nav_catalog_i18n n WHERE n.catalog_id = c.id AND n.lang = t.code)
)
INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit, source_sha, updated_at)
SELECT g.catalog_id, g.lang, sib.title, sib.description, sib.when_to_visit,
       pg_temp.nav_source_sha(dg.title, dg.description, dg.when_to_visit),
       now()
FROM gaps g
JOIN de dg ON dg.catalog_id = g.catalog_id
JOIN LATERAL (
  SELECT n.title, n.description, n.when_to_visit
  FROM nav_catalog_i18n n
  JOIN de d2 ON d2.catalog_id = n.catalog_id
  WHERE n.lang = g.lang
    AND d2.title = dg.title
    AND d2.description = dg.description
    AND d2.when_to_visit = dg.when_to_visit
  ORDER BY n.catalog_id
  LIMIT 1
) sib ON true
ON CONFLICT (catalog_id, lang) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART B — 29 rows requiring real translation (20 distinct text/locale units;
-- duplicate catalog entries share one translation by construction below).
--
-- Register per `supported_locales.informal_hint`:
--   es tú-form · fr tu-form · pl ty-form · pt BRAZILIAN você-form · ru ty-form
--   · sr ti-form, LATIN script (matching every existing sr row).
--
-- Product nouns left untranslated per the surface's translatorBrief: Vitana,
-- Vitanaland, MAXINA/Maxina, ORB, Autopilot, Business Hub, Media Hub.
--
-- `when_to_visit` is a voice-matching phrase list, not prose. It is phrased
-- about the user in the third person in the German source, and that is kept —
-- it is matched against what a user SAYS, so intent coverage matters more than
-- register here.
--
-- Keyed by German title so duplicate catalog entries are covered together and
-- cannot drift apart the way Part A's note describes.
-- ---------------------------------------------------------------------------

WITH de AS (
  SELECT catalog_id, title, description, when_to_visit
  FROM nav_catalog_i18n WHERE lang = 'de'
),
tr (de_title, lang, title, description, when_to_visit) AS (VALUES

 ('Abonnements','fr','Abonnements',
  'Tes abonnements actifs et les services que tu paies.',
  'Quand l''utilisateur demande ses abonnements, ses paiements récurrents, ce pour quoi il paie, ou veut résilier ou gérer un abonnement.'),

 ('Events & Meetups','es','Eventos y Encuentros',
  'Próximos eventos de la comunidad Maxina, encuentros presenciales y reuniones.',
  'Cuando el usuario pregunta en general por eventos y encuentros, la pantalla de Eventos y Encuentros, actividades, reuniones programadas, eventos de baile, talleres de bienestar o actividades de la comunidad a las que puede asistir. Abre la pestaña Hot por defecto.'),

 ('Gesundheits-Tracker','pl','Monitor zdrowia',
  'Śledź swoje codzienne nawyki zdrowotne i zmiany wyniku Vitana Index.',
  'Gdy użytkownik chce otworzyć monitor zdrowia, zapisać nawyk zdrowotny, śledzić wodę, sen, ruch lub kroki, wpisać swoje kroki albo zobaczyć dzisiejszy monitor.'),

 ('Gesundheits-Tracker','sr','Praćenje zdravlja',
  'Prati svoje svakodnevne zdravstvene navike i promene Vitana Index rezultata.',
  'Kada korisnik želi da otvori praćenje zdravlja, zabeleži zdravstvenu naviku, prati vodu, san, kretanje ili korake, unese svoje korake ili vidi današnje praćenje.'),

 ('Inspiration','fr','Inspiration',
  'Des messages inspirants et des conseils bien-être de Vitana.',
  'Quand l''utilisateur demande de l''inspiration, des messages motivants, des conseils bien-être ou de la motivation quotidienne.'),

 ('Meine Tickets','es','Mis entradas',
  'Las entradas que has comprado para eventos y encuentros.',
  'Cuando el usuario pregunta por sus entradas, mis entradas, entradas de eventos o las entradas que ha comprado.'),

 ('Meine Tickets','fr','Mes billets',
  'Les billets que tu as achetés pour des événements et des rencontres.',
  'Quand l''utilisateur demande ses billets, mes billets, les billets d''événement ou les billets qu''il a achetés.'),

 ('Meine Tickets','pl','Moje bilety',
  'Bilety, które kupiłeś na wydarzenia i spotkania.',
  'Gdy użytkownik pyta o swoje bilety, moje bilety, bilety na wydarzenia lub kupione bilety.'),

 ('Meine Tickets','pt','Meus ingressos',
  'Os ingressos que você comprou para eventos e encontros.',
  'Quando o usuário pergunta sobre seus ingressos, meus ingressos, ingressos de eventos ou os ingressos que comprou.'),

 ('Podcasts','fr','Podcasts',
  'Les podcasts et épisodes audio de la communauté.',
  'Quand l''utilisateur demande les podcasts, l''onglet Podcasts ou les épisodes audio dans le Media Hub.'),

 ('Podcasts','pt','Podcasts',
  'Podcasts e episódios em áudio da comunidade.',
  'Quando o usuário pergunta sobre podcasts, a aba Podcasts ou episódios em áudio no Media Hub.'),

 ('Service-Pakete','es','Paquetes de servicios',
  'Paquetes de servicios agrupados que ofreces en tu negocio Maxina.',
  'Cuando el usuario pregunta por la pestaña Paquetes de los servicios del Business Hub, los Business Hub Services Packages, sus paquetes de servicios o las ofertas agrupadas que vende en su negocio.'),

 ('Shorts','es','Shorts',
  'Vídeos cortos de la comunidad: el feed de Shorts.',
  'Cuando el usuario pregunta por los Shorts, vídeos cortos, el feed de Shorts o los reels en el Media Hub.'),

 ('Shorts','fr','Shorts',
  'Les vidéos courtes de la communauté — le fil Shorts.',
  'Quand l''utilisateur demande les Shorts, les vidéos courtes, le fil Shorts ou les reels dans le Media Hub.'),

 ('Shorts','pt','Shorts',
  'Vídeos curtos da comunidade — o feed de Shorts.',
  'Quando o usuário pergunta sobre Shorts, vídeos curtos, o feed de Shorts ou reels no Media Hub.'),

 ('Support','fr','Assistance',
  'Obtenir de l''aide, contacter l''assistance ou signaler un problème.',
  'Quand l''utilisateur demande de l''aide en général, l''assistance, comment contacter l''équipe, veut signaler un bug ou a besoin d''aide, sans nommer une section d''assistance précise.'),

 -- "Tenant" is rendered literally in every locale that already has it
 -- (es Inquilino, pl Dzierżawca, sr Zakupac, ru Тенант). Matching that is a
 -- consistency call, not an endorsement: it is arguably the wrong word in all
 -- of them. Flagged for native review rather than silently diverging here.
 ('Tenant','fr','Locataire',
  'Le locataire ou espace de travail auquel appartient ton compte.',
  'Quand l''utilisateur demande son locataire, son organisation, son espace de travail ou à quel portail Maxina il appartient.'),

 ('Tenant','pt','Locatário',
  'O locatário ou espaço de trabalho ao qual sua conta pertence.',
  'Quando o usuário pergunta sobre seu locatário, sua organização, seu espaço de trabalho ou a qual portal Maxina ele pertence.'),

 ('Tokens','es','Tokens',
  'La pestaña Tokens del saldo de tu monedero.',
  'Cuando el usuario pregunta por sus tokens, el saldo de tokens o la pestaña Tokens del monedero.'),

 ('Tokens','pt','Tokens',
  'A aba Tokens do saldo da sua carteira.',
  'Quando o usuário pergunta sobre seus tokens, o saldo de tokens ou a aba Tokens da carteira.'),

 ('Verkäufe','ru','Продажи',
  'Твой раздел продаж в Business Hub — продавай свои услуги и создавай новый источник дохода в сообществе Maxina.',
  'Когда пользователь спрашивает про вкладку «Продажи», раздел продаж в Business Hub или свои продажи, либо как заработать, получать доход, создать подработку, монетизировать свои навыки, монетизировать коучинг, монетизировать фитнес, монетизировать свою экспертизу, продавать услуги, стать платным автором, создать новый источник дохода или заработать вместе с сообществом Maxina.')
)
INSERT INTO nav_catalog_i18n (catalog_id, lang, title, description, when_to_visit, source_sha, updated_at)
SELECT dg.catalog_id, tr.lang, tr.title, tr.description, tr.when_to_visit,
       pg_temp.nav_source_sha(dg.title, dg.description, dg.when_to_visit),
       now()
FROM tr
JOIN de dg ON dg.title = tr.de_title
JOIN nav_catalog c ON c.id = dg.catalog_id AND c.is_active = true
WHERE EXISTS (SELECT 1 FROM nav_catalog_i18n e WHERE e.catalog_id = dg.catalog_id AND e.lang = 'en')
ON CONFLICT (catalog_id, lang) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART C — topic T178 ("Vitana Coin"), missing in 7 locales.
--
-- Translated from the `en` row, which is itself the pivot the other locales
-- were made from. source_sha stays NULL to match its own en/es siblings.
--
-- ar and zh are `status='draft'` and not user-facing yet; they are included
-- because both already carry the other 253 topics, so leaving T178 out would
-- reintroduce the exact one-row hole this migration exists to close.
-- ---------------------------------------------------------------------------

INSERT INTO journey_checklist_translations (
  topic_id, locale, display_label, short_description,
  explanation_what_it_is, explanation_user_benefit,
  explanation_when_to_use, explanation_try_this
) VALUES

 ('T178','fr','Vitana Coin',
  'Les couches de valeur du portefeuille, expliquées.',
  'Ton portefeuille contient trois types de valeur : de l''argent réel, des crédits pour tes achats et des jetons que tu gagnes grâce à tes activités. C''est ta vue d''ensemble financière dans Vitanaland.',
  'Quand tu connais la différence, tu sais toujours exactement avec quoi tu paies. Cela t''aide à utiliser intelligemment les récompenses que tu as gagnées.',
  'Consulte cette vue d''ensemble avant d''acheter quelque chose, pour décider si tu veux payer en argent réel ou avec tes crédits.',
  'Ouvre ton portefeuille maintenant et regarde les différentes valeurs.'),

 ('T178','pl','Vitana Coin',
  'Warstwy wartości w portfelu — wyjaśnione.',
  'Twój portfel zawiera trzy rodzaje wartości: prawdziwe pieniądze, kredyty na zakupy oraz tokeny zdobywane za aktywność. To Twoje finansowe podsumowanie w Vitanaland.',
  'Gdy znasz różnicę, zawsze dokładnie wiesz, czym płacisz. Dzięki temu mądrze wykorzystasz zdobyte nagrody.',
  'Zajrzyj do tego podsumowania przed zakupem, aby zdecydować, czy chcesz zapłacić prawdziwymi pieniędzmi, czy kredytami.',
  'Otwórz teraz swój portfel i przyjrzyj się poszczególnym wartościom.'),

 ('T178','pt','Vitana Coin',
  'As camadas de valor da carteira, explicadas.',
  'Sua carteira contém três tipos de valor: dinheiro real, créditos para compras e tokens que você ganha com suas atividades. Este é o seu panorama financeiro no Vitanaland.',
  'Quando você sabe a diferença, sempre sabe exatamente com o que está pagando. Isso ajuda você a usar suas recompensas de forma inteligente.',
  'Confira este panorama antes de comprar algo para decidir se quer pagar com dinheiro real ou com seus créditos.',
  'Abra sua carteira agora e veja os diferentes valores.'),

 ('T178','ru','Vitana Coin',
  'Уровни ценности в кошельке — простыми словами.',
  'В твоём кошельке три вида ценности: реальные деньги, кредиты для покупок и токены, которые ты получаешь за активность. Это твой финансовый обзор в Vitanaland.',
  'Когда ты понимаешь разницу, ты всегда точно знаешь, чем платишь. Это помогает разумно использовать заработанные награды.',
  'Загляни в этот обзор перед покупкой, чтобы решить, чем платить — реальными деньгами или кредитами.',
  'Открой кошелёк прямо сейчас и посмотри на разные виды ценности.'),

 ('T178','sr','Vitana Coin',
  'Slojevi vrednosti u novčaniku, objašnjeni.',
  'Tvoj novčanik sadrži tri vrste vrednosti: pravi novac, kredite za kupovinu i tokene koje zarađuješ aktivnostima. To je tvoj finansijski pregled u Vitanaland-u.',
  'Kada znaš razliku, uvek tačno znaš čime plaćaš. To ti pomaže da pametno iskoristiš nagrade koje si zaradio.',
  'Pogledaj ovaj pregled pre nego što nešto kupiš, da odlučiš da li želiš da platiš pravim novcem ili kreditima.',
  'Otvori svoj novčanik sada i pogledaj različite vrednosti.'),

 ('T178','ar','Vitana Coin',
  'شرح طبقات القيمة في المحفظة.',
  'تحتوي محفظتك على ثلاثة أنواع من القيمة: أموال حقيقية، وأرصدة للشراء، ورموز تكسبها من نشاطاتك. هذه هي نظرتك المالية العامة في Vitanaland.',
  'عندما تعرف الفرق، ستعرف دائمًا بالضبط ما الذي تدفع به. هذا يساعدك على استخدام مكافآتك المكتسبة بذكاء.',
  'راجع هذه النظرة العامة قبل شراء أي شيء لتقرر ما إذا كنت تريد الدفع بأموال حقيقية أم من أرصدتك.',
  'افتح محفظتك الآن وألقِ نظرة على القيم المختلفة.'),

 ('T178','zh','Vitana Coin',
  '解读钱包中的价值层级。',
  '你的钱包包含三种价值：真实货币、用于消费的积分，以及你通过各项活动赚取的代币。这是你在 Vitanaland 的财务总览。',
  '了解它们的区别后，你就能随时清楚自己在用什么支付，从而更聪明地使用赚到的奖励。',
  '在购买前查看这份总览，决定你想用真实货币还是积分支付。',
  '现在打开你的钱包，看看这几种不同的价值。')

ON CONFLICT (topic_id, locale) DO NOTHING;

COMMIT;
