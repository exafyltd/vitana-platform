-- VTID-03309 — per-locale verbatim Vitana voice scripts for Guided Journey
-- topic narration.
--
-- WHY: the narration path speaks `vitanaVoiceScript` VERBATIM (no LLM
-- translate; see buildGuidedTopicSpokenLesson + session.say). The published
-- snapshot carries ONE authored script (German base), so a non-German session
-- would otherwise hear German — a forbidden language mix. This stores a
-- per-locale script that getOrbTopicSeed overlays for the session language
-- (de → German, en → English, …).
--
-- ADDITIVE + back-compatible: the column is nullable and only the (new) voice
-- overlay reads it. The public catalog read (getPublishedChecklist →
-- fetchChecklistTranslations) does not select this column and still skips the
-- 'de' locale, so prior behavior is unchanged.

ALTER TABLE public.journey_checklist_translations
  ADD COLUMN IF NOT EXISTS vitana_voice_script text;

-- Allow a 'de' row so the German base voice can be OVERRIDDEN per topic without
-- republishing the shared snapshot (lets staging diverge from prod safely). 'de'
-- stays the catalog source-of-truth locale; only the voice overlay reads it.
ALTER TABLE public.journey_checklist_translations
  DROP CONSTRAINT IF EXISTS journey_checklist_translations_locale_check;
ALTER TABLE public.journey_checklist_translations
  ADD CONSTRAINT journey_checklist_translations_locale_check
  CHECK (locale = ANY (ARRAY['de'::text, 'en'::text, 'es'::text, 'sr'::text]));
