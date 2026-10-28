-- VTID-02651: Make persona voice + greeting fully data-driven so any new
-- specialist can be added with a single INSERT into agent_personas — no
-- code change, no redeploy. Replaces the hardcoded SPECIALIST_VOICES map
-- and getSpecialistGreeting() function in orb-live.ts.
--
-- Adds:
--   1. agent_personas.greeting_templates JSONB — per-language greeting the
--      persona speaks the first time they pick up a swapped call. Shape:
--        { "en": "Hi, Devon here — …", "de": "Hallo, Devon hier — …", ... }
--      Loaded by loadPersonaRegistry() at runtime; falls back to a generic
--      template built from display_name if a language is missing.
--
-- Backfills voice_id + greeting_templates for the 4 v1 specialists. Vitana
-- keeps voice_id NULL (sentinel for "use language default per LIVE_API_VOICES").

ALTER TABLE public.agent_personas
  ADD COLUMN IF NOT EXISTS greeting_templates JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill voice IDs (chosen earlier so each specialist is distinct from
-- Vitana AND from each other across genders).
UPDATE public.agent_personas SET voice_id = 'Charon'  WHERE key = 'devon' AND voice_id IS NULL;
UPDATE public.agent_personas SET voice_id = 'Leda'    WHERE key = 'sage'  AND voice_id IS NULL;
UPDATE public.agent_personas SET voice_id = 'Orus'    WHERE key = 'atlas' AND voice_id IS NULL;
UPDATE public.agent_personas SET voice_id = 'Zephyr'  WHERE key = 'mira'  AND voice_id IS NULL;

-- Backfill greeting templates per language for each specialist.
UPDATE public.agent_personas SET greeting_templates = jsonb_build_object(
  'en', 'Hi, Devon here — Vitana said you ran into an issue. Walk me through what happened.',
  'de', 'Hallo, Devon hier — Vitana hat mir gesagt, dass du ein Problem hast. Erzähl mir, was passiert ist.',
  'fr', 'Salut, Devon à l''appareil — Vitana m''a dit que tu as rencontré un souci. Raconte-moi ce qui s''est passé.',
  'es', 'Hola, soy Devon — Vitana me ha dicho que tienes un problema. Cuéntame qué ha pasado.'
) WHERE key = 'devon';

UPDATE public.agent_personas SET greeting_templates = jsonb_build_object(
  'en', 'Hi, Sage here. What can I help you find?',
  'de', 'Hallo, Sage hier. Wobei kann ich dir helfen?',
  'fr', 'Bonjour, Sage à l''appareil. Comment puis-je t''aider ?',
  'es', 'Hola, soy Sage. ¿En qué puedo ayudarte?'
) WHERE key = 'sage';

UPDATE public.agent_personas SET greeting_templates = jsonb_build_object(
  'en', 'Hi, Atlas here. Let''s sort this out — what''s going on with your order or payment?',
  'de', 'Hallo, Atlas hier. Klären wir das — was ist mit deiner Bestellung oder Zahlung los?',
  'fr', 'Bonjour, Atlas à l''appareil. Réglons ça — qu''est-ce qui se passe avec ta commande ou ton paiement ?',
  'es', 'Hola, soy Atlas. Vamos a resolverlo — ¿qué pasa con tu pedido o pago?'
) WHERE key = 'atlas';

UPDATE public.agent_personas SET greeting_templates = jsonb_build_object(
  'en', 'Hi, Mira here. Let''s get your account sorted — what''s not working?',
  'de', 'Hallo, Mira hier. Bringen wir deinen Account in Ordnung — was funktioniert nicht?',
  'fr', 'Bonjour, Mira à l''appareil. Réglons ton compte — qu''est-ce qui ne marche pas ?',
  'es', 'Hola, soy Mira. Pongamos tu cuenta en orden — ¿qué no funciona?'
) WHERE key = 'mira';

-- Vitana's own back-from-handoff greeting — used when a specialist hands
-- the call back via switch_persona({to:'vitana'}).
UPDATE public.agent_personas SET greeting_templates = jsonb_build_object(
  'en', 'Welcome back. What''s on your mind?',
  'de', 'Willkommen zurück. Was beschäftigt dich gerade?',
  'fr', 'Te revoilà. Qu''est-ce qui te préoccupe ?',
  'es', 'Bienvenido de vuelta. ¿En qué piensas?'
) WHERE key = 'vitana';

-- View for the gateway service to load the registry in one query.
CREATE OR REPLACE VIEW public.agent_personas_registry AS
  SELECT
    id,
    key,
    display_name,
    role,
    voice_id,
    system_prompt,
    intake_schema_ref,
    handles_kinds,
    handoff_keywords,
    greeting_templates,
    status,
    version,
    updated_at
  FROM public.agent_personas
  WHERE status = 'active';

GRANT SELECT ON public.agent_personas_registry TO authenticated, service_role;
