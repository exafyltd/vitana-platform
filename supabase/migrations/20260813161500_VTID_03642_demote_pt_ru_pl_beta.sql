-- VTID-03642 — demote pt/ru/pl back to 'beta' in the locale registry, mirroring
-- VTID-03640's frontend demotion.
--
-- WHY THIS EXISTS
--
-- VTID-03580 (20260810230000) promoted these three to 'ga' here on the strength
-- of catalog coverage alone. What it didn't check: ORB Live's voice backend.
-- Nova Sonic only speaks en/de/fr/es (NOVA_SONIC_SUPPORTED_LANGUAGES), and
-- Vertex/Gemini Live's fallback voice map (LIVE_LANGUAGE_VOICE_FALLBACKS) has
-- no entry for pl or pt at all — a user who picked either heard fluent English
-- the moment they opened ORB, with no error and nothing to indicate it.
--
-- VTID-03640 (same conversation) demoted the vitana-v1 picker back to 'beta'
-- for exactly this reason. `scripts/check-locale-registry.mjs` (VTID-03519)
-- immediately caught the resulting drift on PR #993's CI:
--
--   'pt' status disagrees: picker='beta', supported_locales='ga'
--   'ru' status disagrees: picker='beta', supported_locales='ga'
--   'pl' status disagrees: picker='beta', supported_locales='ga'
--
-- This migration is the other half of that fix. Russian is demoted alongside
-- pt/pl even though it has partial coverage via Vertex's fallback voice today
-- (unlike pt/pl, which have none) — VTID-03640's frontend comment records the
-- reasoning: one consistent "still being finished" story across the three
-- sibling locales, not a picker/voice combination that treats them
-- inconsistently for reasons no UI text explains.
--
-- Re-promote alongside VTID-03641 (Polly-backed ORB voice fallback for
-- languages neither Nova nor Vertex can speak natively) once that ships.

-- impact-allow-solo-migration
--   Deliberately code-free, mirroring VTID-03580's own migration: a two-row
--   status change to a config registry designed for exactly this (VTID-03515).
--   No gateway code change accompanies it — check-locale-registry.mjs reads
--   this table directly over PostgREST, so the fix is the row itself.

UPDATE public.supported_locales
   SET status = 'beta'
 WHERE code IN ('pt', 'ru', 'pl')
   AND status = 'ga';
