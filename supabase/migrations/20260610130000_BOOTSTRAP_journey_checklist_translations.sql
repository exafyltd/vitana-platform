-- =============================================================================
-- Guided Journey — curriculum content translations (per-locale)
-- BOOTSTRAP-GUIDED-JOURNEY-POPUP
-- -----------------------------------------------------------------------------
-- The curriculum (`journey_checklist_topics` + published snapshots) is authored
-- in GERMAN — the source of truth. The Topic Explanation popup therefore showed
-- German body text even when the user picked English/Spanish/Serbian (only the
-- field LABELS were translated client-side). This table holds per-locale
-- translations of the user-facing topic content; the gateway overlays them onto
-- the published snapshot at read time, falling back to the German source when a
-- field/locale is missing.
--
-- DE is never stored here (it lives in the snapshot). Rows are produced by
-- `scripts/journey/generate-checklist-translations.mjs` (LLM batch translate of
-- the current published snapshot) and refreshed when a new version publishes.
--
-- SECURITY: gateway service-role only. RLS enabled with NO permissive policy.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.journey_checklist_translations (
  topic_id                 text NOT NULL,
  locale                   text NOT NULL CHECK (locale IN ('en','es','sr')),
  display_label            text,
  short_description        text,
  explanation_what_it_is   text,
  explanation_user_benefit text,
  explanation_when_to_use  text,
  explanation_try_this     text,
  -- Which published version this translation was generated from, so a re-publish
  -- can detect stale rows and regenerate. NULL tolerated for bootstrap inserts.
  source_version_id        uuid,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, locale)
);

CREATE INDEX IF NOT EXISTS idx_journey_checklist_translations_locale
  ON public.journey_checklist_translations (locale);

ALTER TABLE public.journey_checklist_translations ENABLE ROW LEVEL SECURITY;
-- No permissive policy: only the gateway service-role may read/write.

COMMENT ON TABLE public.journey_checklist_translations IS
  'BOOTSTRAP-GUIDED-JOURNEY-POPUP — per-locale (en/es/sr) translations of user-facing Guided Journey topic content. Overlaid on the published (German) snapshot by the gateway; missing fields fall back to German.';

COMMIT;
