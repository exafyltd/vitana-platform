-- Forwarding v2 — phrase expansion
--
-- After a real-world test session showed Vitana still forwarding instruction-
-- manual questions, this migration extends Vitana's stay_inline_phrases with
-- common onboarding phrasings (English + German) the v1 seed missed:
-- "show me how", "how to", "help me understand", "i'm new", "first time",
-- "walk me through", "demonstrate", "what does X do", etc.
--
-- Idempotent: uses array_cat with a fingerprint check so re-running doesn't
-- produce duplicates.

DO $$
DECLARE
  v_existing TEXT[];
  v_to_add   TEXT[] := ARRAY[
    -- English onboarding phrasings
    'show me how', 'show me', 'how to', 'how do you',
    'help me understand', 'i don''t understand',
    'i''m new', 'i am new', 'first time', 'just started',
    'i''d like to learn', 'i want to learn', 'teach me',
    'walk me through', 'guide me', 'demonstrate',
    'what does', 'what do', 'why does', 'why is',
    'where can i', 'where can', 'where do i',
    'show me how to use', 'how do i use',
    'instruction manual', 'manual', 'documentation',
    'tutorial', 'guide me through',
    -- German onboarding
    'zeig mir', 'zeige mir', 'zeig mal',
    'wie geht', 'wie funktioniert', 'wie verwende ich',
    'lerne ich', 'ich bin neu', 'erstes mal',
    'führ mich', 'erkläre mir', 'erklär mir',
    'was macht', 'was tut', 'wofür ist',
    'wo finde ich', 'wo kann ich', 'wo ist',
    'anleitung', 'handbuch', 'tutorial', 'führung'
  ]::TEXT[];
  v_merged TEXT[];
BEGIN
  SELECT stay_inline_phrases INTO v_existing
  FROM public.agent_personas
  WHERE key = 'vitana';

  -- Dedupe: lowercase comparison.
  SELECT array_agg(DISTINCT phrase)
  INTO v_merged
  FROM (
    SELECT lower(p) AS phrase FROM unnest(coalesce(v_existing, ARRAY[]::TEXT[])) p
    UNION
    SELECT lower(p) FROM unnest(v_to_add) p
  ) t;

  UPDATE public.agent_personas
  SET stay_inline_phrases = v_merged,
      version = version + 1,
      updated_at = NOW()
  WHERE key = 'vitana';
END $$;
