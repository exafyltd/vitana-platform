-- Forwarding v2c — coverage gaps for German + missing English phrasings
--
-- Test failures from /tmp/forwarding-test-suite.sh exposed three coverage gaps:
--   3.3 "I want a refund" → not in forward_request_phrases (only "I need a refund")
--   3.7 "ich habe einen Fehler" → German bug-report phrasings missing
--   3.5/3.6 German concrete-problem phrasings pass Gate A but no specialist
--          matches (Atlas/Mira have no German topic keywords).
--
-- This migration extends forward_request_phrases on Vitana AND extends
-- handoff_keywords on Atlas + Mira (German equivalents). Idempotent via
-- DISTINCT lower-case dedupe.

-- 1. Vitana: extend forward_request_phrases
DO $$
DECLARE
  v_existing TEXT[];
  v_to_add TEXT[] := ARRAY[
    -- English: refund / claim variants the v1 seed missed
    'i want a refund', 'i would like a refund', 'i request a refund',
    'i want my money back', 'request a refund',
    -- English: bug variants
    'i have an error', 'something is broken',
    -- German: bug variants
    'ich habe einen fehler', 'es ist ein fehler aufgetreten',
    'es funktioniert nicht', 'etwas stimmt nicht',
    'ich möchte einen fehler melden', 'ich will einen fehler melden',
    -- German: refund variants
    'ich will meine geld zurück', 'ich möchte mein geld zurück',
    'ich möchte eine rückerstattung', 'ich will eine rückerstattung',
    -- German: account variants
    'ich kann mich nicht einloggen', 'login geht nicht',
    'ich komme nicht in mein konto', 'mein passwort funktioniert nicht'
  ]::TEXT[];
  v_merged TEXT[];
BEGIN
  SELECT forward_request_phrases INTO v_existing
  FROM public.agent_personas
  WHERE key = 'vitana';

  SELECT array_agg(DISTINCT phrase ORDER BY phrase)
  INTO v_merged
  FROM (
    SELECT lower(p) AS phrase FROM unnest(coalesce(v_existing, ARRAY[]::TEXT[])) p
    UNION
    SELECT lower(p) FROM unnest(v_to_add) p
  ) t;

  UPDATE public.agent_personas
  SET forward_request_phrases = v_merged,
      version = version + 1,
      updated_at = NOW()
  WHERE key = 'vitana';
END $$;

-- 2. Atlas: extend handoff_keywords with German finance terms
DO $$
DECLARE
  v_existing TEXT[];
  v_to_add TEXT[] := ARRAY[
    -- German finance / marketplace
    'rückerstattung', 'erstattung', 'geld zurück', 'rechnung',
    'zahlung', 'zurückzahlung', 'reklamation', 'beschwerde',
    'falsche bestellung', 'falsche lieferung', 'nicht erhalten',
    'beschädigt', 'preis', 'überzahlt', 'streitfall',
    -- English augment
    'reimbursement', 'cashback', 'overcharge', 'fraudulent charge'
  ]::TEXT[];
  v_merged TEXT[];
BEGIN
  SELECT handoff_keywords INTO v_existing
  FROM public.agent_personas
  WHERE key = 'atlas';

  SELECT array_agg(DISTINCT kw ORDER BY kw)
  INTO v_merged
  FROM (
    SELECT lower(p) AS kw FROM unnest(coalesce(v_existing, ARRAY[]::TEXT[])) p
    UNION
    SELECT lower(p) FROM unnest(v_to_add) p
  ) t;

  UPDATE public.agent_personas
  SET handoff_keywords = v_merged,
      version = version + 1,
      updated_at = NOW()
  WHERE key = 'atlas';
END $$;

-- 3. Mira: extend handoff_keywords with German account terms
DO $$
DECLARE
  v_existing TEXT[];
  v_to_add TEXT[] := ARRAY[
    'gesperrt', 'einloggen', 'login', 'anmelden', 'passwort',
    'konto', 'profil', 'email', 'e-mail', 'registrierung',
    'verifizieren', 'rolle', 'berechtigung', 'ausgesperrt',
    'kann nicht zugreifen'
  ]::TEXT[];
  v_merged TEXT[];
BEGIN
  SELECT handoff_keywords INTO v_existing
  FROM public.agent_personas
  WHERE key = 'mira';

  SELECT array_agg(DISTINCT kw ORDER BY kw)
  INTO v_merged
  FROM (
    SELECT lower(p) AS kw FROM unnest(coalesce(v_existing, ARRAY[]::TEXT[])) p
    UNION
    SELECT lower(p) FROM unnest(v_to_add) p
  ) t;

  UPDATE public.agent_personas
  SET handoff_keywords = v_merged,
      version = version + 1,
      updated_at = NOW()
  WHERE key = 'mira';
END $$;

-- 4. Devon: extend handoff_keywords with German bug terms
DO $$
DECLARE
  v_existing TEXT[];
  v_to_add TEXT[] := ARRAY[
    'fehler', 'absturz', 'abgestürzt', 'eingefroren', 'hängt',
    'stürzt ab', 'funktioniert nicht', 'kaputt', 'glitch',
    'bildschirm', 'schaltfläche', 'knopf'
  ]::TEXT[];
  v_merged TEXT[];
BEGIN
  SELECT handoff_keywords INTO v_existing
  FROM public.agent_personas
  WHERE key = 'devon';

  SELECT array_agg(DISTINCT kw ORDER BY kw)
  INTO v_merged
  FROM (
    SELECT lower(p) AS kw FROM unnest(coalesce(v_existing, ARRAY[]::TEXT[])) p
    UNION
    SELECT lower(p) FROM unnest(v_to_add) p
  ) t;

  UPDATE public.agent_personas
  SET handoff_keywords = v_merged,
      version = version + 1,
      updated_at = NOW()
  WHERE key = 'devon';
END $$;

-- 5. Re-enable Sage if she was disabled by a manual toggle (so tests have a
-- known starting state). Idempotent: only resets when status='disabled'.
UPDATE public.agent_personas
SET status = 'active', version = version + 1, updated_at = NOW()
WHERE key = 'sage' AND status = 'disabled';
