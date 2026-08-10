-- VTID-03580 — promote pt/ru/pl to GA in the locale registry, and correct the
-- Portuguese register hint to Brazilian.
--
-- WHY THIS EXISTS AS A SEPARATE STEP FROM THE FRONTEND FLIP
--
-- `supported_locales` and vitana-v1's `languageOptions` are two independent
-- statements about the same fact, and `scripts/check-locale-registry.mjs` fails
-- CI when they disagree — which is exactly how this migration got written. The
-- frontend promotion alone produced:
--
--   'pt' status disagrees: picker='ga', supported_locales='beta'
--   A locale that is user-selectable but unseedable ships a half-German UI.
--
-- That is not a bookkeeping nit. `status` gates which locales the DB-content
-- seeder (`seed-db-i18n.ts`) will write, and the two surfaces it owns —
-- `nav_catalog_i18n` (Navigator titles, read by ORB voice intent matching) and
-- `journey_checklist_translations` (the My Journey curriculum) — never pass
-- through `src/i18n/`. A locale can sit at 100% catalog parity and still speak
-- German on both. Selectable-but-unseedable is the worst of the three states,
-- because the user picks the language and then meets German content with no
-- indication anything is missing.
--
-- The GA conditions were verified per locale before this ran, not assumed:
-- 100.0% coverage (14,199/14,199) against DE, 0 `_pending_review`, 0 placeholder
-- mismatches, 0 drift vs the EN source, and 0 register violations.

UPDATE public.supported_locales
   SET status = 'ga'
 WHERE code IN ('pt', 'ru', 'pl');

-- The Portuguese hint was still European, three commits after VTID-03577 flipped
-- the product decision to Brazilian. Nothing checked it: the registry gate
-- compares STATUS between the two sides and never looks at `informal_hint`, and
-- `i18n-register-check.mjs` reads its rules from `scripts/i18n-register-rules.mjs`
-- rather than from this table. So the two halves of "Portuguese is Brazilian"
-- could — and did — disagree silently.
--
-- This column is not documentation. It is injected into the translator prompt
-- for the two DB-content surfaces above, so leaving it would have produced
-- European Portuguese for the Navigator and the curriculum while the UI catalog
-- was Brazilian: one language, two variants, split along a seam no reviewer
-- looks at.
UPDATE public.supported_locales
   SET informal_hint = 'Use BRAZILIAN Portuguese (pt-BR) with the informal voce-form. '
                       'Never o senhor/a senhora, and never the European tu-form '
                       '(tu/teu/tua, or enclisis such as da-te). Prefer Brazilian '
                       'vocabulary and proclisis: "te da", not "da-te".'
 WHERE code = 'pt';

-- ar and zh stay 'draft' deliberately: at 99.8% and 99.9% they are below parity,
-- which is a content gap, not an unflipped switch.
