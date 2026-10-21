-- =============================================================================
-- VTID-03515 — DB-content i18n: locale registry + staleness stamps
-- -----------------------------------------------------------------------------
-- WHY THIS EXISTS
--
-- Two tables hold user-visible content that does NOT come from src/i18n/ and is
-- therefore invisible to every frontend i18n check:
--
--   nav_catalog_i18n              (title, description, when_to_visit)  — Navigator
--   journey_checklist_translations (6 fields)                          — My Journey
--
-- Preparing the 18 Aug 2026 8-language release surfaced two structural problems
-- that make "add language N+1" a code change instead of a data change:
--
-- 1. `journey_checklist_translations.locale` carries
--        CHECK (locale IN ('en','es','sr'))
--    so INSERTing fr/pt/ru/pl is REJECTED BY THE DATABASE. Any seeding script
--    aimed at the new release locales fails at the constraint, not at the
--    content. Every future language would need its own migration to widen a
--    hardcoded list — precisely the manual step this VTID is asked to remove.
--
-- 2. Neither table records WHAT SOURCE TEXT a translation was made from.
--    `journey_checklist_translations.source_version_id` tracks the published
--    *version*, which is coarser than the unit that actually changes: a single
--    topic edited and re-published inside the same version, or a nav entry
--    whose German description was reworded, both leave every dependent
--    translation looking current. `nav_catalog_i18n` has no staleness mechanism
--    of any kind. This is the same blindness that let es/sr sit two months
--    stale at 100% "coverage" in the frontend catalogs — coverage counts rows,
--    and a stale row is still a row.
--
-- WHAT THIS CHANGES
--
-- (a) `supported_locales` — ONE registry row per locale, replacing the
--     hardcoded CHECK list. Adding a language becomes an INSERT, and the
--     constraint follows automatically via foreign key. The registry is
--     deliberately a table and not an enum: adding an enum value is DDL (a
--     migration), adding a row is data (a seeding run).
--
-- (b) `source_sha` on both content tables — a short hash of the exact source
--     text a row was translated from. Staleness becomes a JOIN instead of a
--     guess, and it works per-row, which is the granularity edits actually
--     happen at.
--
-- SAFETY
--
-- Both foreign keys are added NOT VALID and validated in the same transaction
-- AFTER back-filling the registry from whatever locale values the tables
-- already contain. That ordering matters: validating first against a registry
-- that does not yet know about a legacy value would abort the migration on
-- production data nobody has looked at in a year. Back-fill-then-validate can
-- only fail if a row holds NULL/'' — which the NOT NULL columns already forbid.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. The registry
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.supported_locales (
  code            text PRIMARY KEY,
  english_name    text NOT NULL,
  -- Informal-register hint carried into the LLM system prompt by the seeding
  -- pipeline. Vitana's brand voice is informal in every language (du/tú/ti/ty);
  -- a translator left to its own defaults reliably emits the formal register,
  -- and formal German ("Sie") is the single most-reported catalog defect.
  informal_hint   text NOT NULL DEFAULT '',
  -- 'ga'    — user-selectable, must be at full parity
  -- 'beta'  — behind ?i18n-preview=1, parity not yet required
  -- 'draft' — not shipped (needs RTL work, CJK fonts, …)
  -- 'legacy'— found in existing data, not a release target (back-fill only)
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('ga', 'beta', 'draft', 'legacy')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.supported_locales IS
  'VTID-03515 — single registry of locales the platform serves DB-backed content in. Referenced by nav_catalog_i18n.lang and journey_checklist_translations.locale. Adding a language is an INSERT here, never a migration.';

-- Release set for 18 Aug 2026, mirroring `languageOptions` in
-- vitana-v1/src/contexts/LanguageContext.tsx as it stood at this migration.
--
-- These two lists must agree, and NOTHING CURRENTLY ENFORCES THAT. A locale
-- that is 'ga' in the frontend picker but absent here cannot receive DB content
-- and renders German Navigator titles inside an otherwise translated UI — which
-- is the failure this VTID is cleaning up, one level down. Closing that gap
-- means having the frontend read this table (it is deliberately world-readable
-- below) instead of holding its own copy; that is a frontend change and is
-- listed as follow-up work rather than asserted here.
INSERT INTO public.supported_locales (code, english_name, informal_hint, status) VALUES
  ('de', 'German',     'Use the informal du-form throughout. Never Sie/Ihr/Ihnen.',        'ga'),
  ('en', 'English',    'Direct, warm, second person. No corporate register.',              'ga'),
  ('es', 'Spanish',    'Use the informal tu-form (tu/tus). Never usted.',                  'ga'),
  ('sr', 'Serbian',    'Use the informal ti-form. Never Vi/Vas/Vasa.',                     'ga'),
  ('fr', 'French',     'Use the informal tu-form. Never vous as a singular address.',      'ga'),
  ('pt', 'Portuguese', 'Use the informal tu-form (European Portuguese). Never o senhor.',  'beta'),
  ('ru', 'Russian',    'Use the informal ty-form. Never the polite plural vy.',            'beta'),
  ('pl', 'Polish',     'Use the informal ty-form. Never Pan/Pani.',                        'beta'),
  ('ar', 'Arabic',     'Informal second person. Layout is RTL — not yet shipped.',         'draft'),
  ('zh', 'Chinese',    'Simplified Chinese, informal. Needs a CJK font stack.',            'draft')
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Back-fill anything the live tables already reference
-- -----------------------------------------------------------------------------
-- Runs BEFORE the FKs are validated. Without this the migration would abort on
-- any locale value present in production but absent from the list above.

INSERT INTO public.supported_locales (code, english_name, status)
SELECT DISTINCT lang, lang, 'legacy'
  FROM public.nav_catalog_i18n
 WHERE lang IS NOT NULL AND lang <> ''
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.supported_locales (code, english_name, status)
SELECT DISTINCT locale, locale, 'legacy'
  FROM public.journey_checklist_translations
 WHERE locale IS NOT NULL AND locale <> ''
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Replace the hardcoded CHECK with the registry FK
-- -----------------------------------------------------------------------------
-- THE ACTUAL BLOCKER: this CHECK is why seeding fr/pt/ru/pl fails today.
-- The constraint name is the one PostgreSQL generates for an inline column
-- CHECK; drop by name if present, and fall back to a catalog lookup so this
-- still works if the table was created by hand with a different name.

ALTER TABLE public.journey_checklist_translations
  DROP CONSTRAINT IF EXISTS journey_checklist_translations_locale_check;

DO $$
DECLARE
  c record;
BEGIN
  -- Any *other* CHECK on this table that names the retired locale list.
  FOR c IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public'
       AND rel.relname = 'journey_checklist_translations'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%locale%'
       AND pg_get_constraintdef(con.oid) ILIKE '%''sr''%'
  LOOP
    EXECUTE format('ALTER TABLE public.journey_checklist_translations DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE 'VTID-03515: dropped legacy locale CHECK %', c.conname;
  END LOOP;
END $$;

ALTER TABLE public.journey_checklist_translations
  DROP CONSTRAINT IF EXISTS journey_checklist_translations_locale_fkey;
ALTER TABLE public.journey_checklist_translations
  ADD CONSTRAINT journey_checklist_translations_locale_fkey
  FOREIGN KEY (locale) REFERENCES public.supported_locales(code)
  ON UPDATE CASCADE
  NOT VALID;
ALTER TABLE public.journey_checklist_translations
  VALIDATE CONSTRAINT journey_checklist_translations_locale_fkey;

ALTER TABLE public.nav_catalog_i18n
  DROP CONSTRAINT IF EXISTS nav_catalog_i18n_lang_fkey;
ALTER TABLE public.nav_catalog_i18n
  ADD CONSTRAINT nav_catalog_i18n_lang_fkey
  FOREIGN KEY (lang) REFERENCES public.supported_locales(code)
  ON UPDATE CASCADE
  NOT VALID;
ALTER TABLE public.nav_catalog_i18n
  VALIDATE CONSTRAINT nav_catalog_i18n_lang_fkey;

-- -----------------------------------------------------------------------------
-- 4. Per-row staleness stamps
-- -----------------------------------------------------------------------------
-- sha1(source text)[0:16]. NULL means "never stamped" — reported distinctly
-- from "stamped and drifted", because the two need different responses: an
-- unstamped row is a pre-pipeline legacy row of unknown provenance, a drifted
-- row is a known-stale translation with a known source.
--
-- NOT back-filled with the current source hash. Doing so would assert that
-- every existing row matches today's German, which is exactly the lie the
-- frontend catalogs told for two months. Legacy rows stay NULL until the
-- pipeline re-translates or an operator explicitly stamps them.

ALTER TABLE public.nav_catalog_i18n
  ADD COLUMN IF NOT EXISTS source_sha text;
ALTER TABLE public.journey_checklist_translations
  ADD COLUMN IF NOT EXISTS source_sha text;

COMMENT ON COLUMN public.nav_catalog_i18n.source_sha IS
  'VTID-03515 — sha1 of the source (de) title/description/when_to_visit this row was translated from, first 16 hex chars. NULL = never stamped (legacy row, provenance unknown). Drift = stored value differs from the current source hash.';
COMMENT ON COLUMN public.journey_checklist_translations.source_sha IS
  'VTID-03515 — sha1 of the six source (de) fields this row was translated from, first 16 hex chars. Finer-grained than source_version_id, which cannot see a single topic edited within one published version.';

CREATE INDEX IF NOT EXISTS journey_checklist_translations_locale_sha_idx
  ON public.journey_checklist_translations (locale, source_sha);
CREATE INDEX IF NOT EXISTS nav_catalog_i18n_lang_sha_idx
  ON public.nav_catalog_i18n (lang, source_sha);

-- -----------------------------------------------------------------------------
-- 5. Registry read access
-- -----------------------------------------------------------------------------
-- The two content tables are service-role only and stay that way. The registry
-- itself holds no user data — it is a list of language codes — and the frontend
-- benefits from reading it directly rather than duplicating the list a third
-- time. Read-only to everyone; writes remain service-role.

ALTER TABLE public.supported_locales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS supported_locales_read ON public.supported_locales;
CREATE POLICY supported_locales_read
  ON public.supported_locales
  FOR SELECT
  USING (true);

COMMIT;
