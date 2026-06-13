-- =============================================================================
-- BOOTSTRAP-FIRST-TIME-ONBOARDING — four opening Longevity Journey sessions
-- -----------------------------------------------------------------------------
-- First-time users were dropped straight into "What Is Vitanaland" (product-
-- first). This migration prepends four journey-first onboarding sessions:
--
--   session 1  T251  Starte deine Longevity-Reise  (Start Your Longevity Journey)
--   session 2  T252  Dein Plan                     (Your Plan)
--   session 3  T253  Dein erster Schritt           (Your First Step)
--   session 4  T254  Dein Fortschritt              (Your Progress)
--
-- All existing v2 sessions shift +4 (T001 "What Is Vitanaland" becomes
-- session 5), so the curriculum is now 94 sessions / 254 topics:
--   1. session CHECK widened 1..90 → 1..94.
--   2. Draft rows renumbered (+1000/-996 two-step to dodge the
--      UNIQUE(curriculum_version, session, position) during the shift).
--   3. user_guided_journey_state.current_session shifted +4 for users already
--      past session 1, so their pointer keeps referencing the SAME content.
--   4. The CURRENT published snapshot (if any) is rewritten in place — sessions
--      +4 and the four new topics prepended — so the change is live without a
--      manual re-publish.
--   5. en/es/sr translation rows added (source content is German, the
--      curriculum's source-of-truth language; vitana_voice_script stays English
--      by design — it is LLM guidance material, narrated in the user's locale).
--
-- Idempotent: every step is guarded on the presence of T251.
-- =============================================================================

BEGIN;

-- 1. Widen the session bound to fit the four new opening sessions.
ALTER TABLE journey_checklist_topics
  DROP CONSTRAINT IF EXISTS journey_checklist_topics_session_check;
ALTER TABLE journey_checklist_topics
  ADD CONSTRAINT journey_checklist_topics_session_check CHECK (session BETWEEN 1 AND 94);

-- 2 + 3. Renumber the existing draft curriculum and user session pointers.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journey_checklist_topics WHERE topic_id = 'T251') THEN
    -- Two-step shift: a direct +4 collides with not-yet-updated rows under the
    -- UNIQUE(curriculum_version, session, position) constraint.
    UPDATE journey_checklist_topics SET session = session + 1000
      WHERE curriculum_version = 'v2';
    UPDATE journey_checklist_topics SET session = session - 996, updated_at = now()
      WHERE curriculum_version = 'v2' AND session > 1000;

    -- Keep existing users pointed at the same CONTENT they were on. Users still
    -- at session 1 (not started / barely started) begin with the new opening.
    UPDATE user_guided_journey_state
      SET current_session = LEAST(current_session + 4, 94)
      WHERE current_session > 1;
  END IF;
END
$mig$;

-- 4. The four onboarding topics (German source; English voice scripts are LLM
--    guidance material — the narration provider teaches in the user's locale).
INSERT INTO journey_checklist_topics
  (topic_id, curriculum_version, session, position, chapter_id, display_label, title,
   short_description, vitana_voice_script,
   explanation_what_it_is, explanation_user_benefit, explanation_when_to_use, explanation_try_this,
   guided_practice_target, practice_action_type, completion_event, business_gate, status)
VALUES
  ('T251', 'v2', 1, 1, 'basics',
   'Starte deine Longevity-Reise', 'Starte deine Longevity-Reise',
   'Hier beginnt deine Reise – Schritt für Schritt.',
   $vs$Welcome. This is the beginning of your longevity journey. You do not need to understand everything today, and you do not need to change everything at once. We will move step by step.

Your journey is here to help you build a healthier, stronger, and more balanced life over time. Each session gives you one clear idea, one small action, or one moment of reflection.

Today, your only task is to begin. I will guide you through the journey, help you understand your plan, and show you how small steps can create meaningful progress.

Let us start with your first step.$vs$,
   'Der Beginn deiner Longevity-Reise – ohne Druck, Schritt für Schritt.',
   'Du weißt sofort, wie deine Reise funktioniert und wie du startest.',
   'Gleich jetzt, als allerersten Schritt deiner Reise.',
   'Höre Vitana zu und starte danach deine erste Sitzung.',
   'my_journey', 'orb_explain', 'topic_explained_T251', NULL, 'draft'),

  ('T252', 'v2', 2, 1, 'basics',
   'Dein Plan', 'Dein Plan',
   'So findet deine Reise die richtigen nächsten Schritte für dich.',
   $vs$Your longevity journey works best when it feels personal. That is why your plan is not about doing everything at once. It is about finding the right next steps for you.

Together, we will look at the areas that support long-term health: your energy, your routines, your movement, your nutrition, your sleep, your mindset, and your daily rhythm.

Your plan will help you focus on what matters now, while still keeping the bigger picture in view. You will always know what your next step is, and why it matters.

This is your path. I will help you follow it one session at a time.$vs$,
   'Dein persönlicher Plan für langfristige Gesundheit.',
   'Du weißt immer, was dein nächster Schritt ist – und warum er zählt.',
   'Wenn du verstehen willst, wie deine Reise aufgebaut ist.',
   'Schau dir deinen Plan an und merke dir deinen nächsten Schritt.',
   'my_journey', 'orb_explain', 'topic_explained_T252', NULL, 'draft'),

  ('T253', 'v2', 3, 1, 'basics',
   'Dein erster Schritt', 'Dein erster Schritt',
   'Klein anfangen, dranbleiben – so wird deine Reise real.',
   $vs$Every journey becomes real when you take the first step. It does not need to be big. In fact, the best first step is usually small, clear, and easy to repeat.

A longevity journey is not built by pressure. It is built by rhythm. One useful choice, repeated over time, can become part of the way you live.

Today, choose one simple action that supports your health. It might be drinking more water, taking a short walk, going to bed a little earlier, or taking one quiet minute to check in with yourself.

Your first step matters because it turns intention into movement. Start small, and keep going.$vs$,
   'Eine kleine, klare Aktion, die deine Gesundheit unterstützt.',
   'Aus guten Absichten wird echte Bewegung.',
   'Heute – dein erster Schritt darf klein sein.',
   'Wähle eine einfache Aktion: mehr Wasser, ein kurzer Spaziergang oder früher ins Bett.',
   'my_journey', 'orb_explain', 'topic_explained_T253', NULL, 'draft'),

  ('T254', 'v2', 4, 1, 'basics',
   'Dein Fortschritt', 'Dein Fortschritt',
   'Fortschritt heißt dranbleiben, nicht perfekt sein.',
   $vs$Progress is not about being perfect. It is about noticing where you are, learning from each step, and continuing with more awareness.

Some days will feel easy. Other days will feel busy or difficult. That is normal. What matters is that you return to your journey and keep building small moments of care for yourself.

As you complete sessions, you will see your next step, your growing progress, and the path ahead. This helps you understand that every session is part of something bigger.

Your progress begins with showing up. Each session brings you closer.$vs$,
   'So siehst du, wie deine Sitzungen zu echtem Fortschritt werden.',
   'Du erkennst, dass jede Sitzung Teil von etwas Größerem ist.',
   'Wenn du sehen willst, wie weit du schon gekommen bist.',
   'Schließe diese Sitzung ab und sieh zu, wie dein Fortschritt wächst.',
   'my_journey', 'orb_explain', 'topic_explained_T254', NULL, 'draft')
ON CONFLICT (topic_id) DO NOTHING;

-- 5. en/es/sr translations of the user-facing fields (DE lives in the source).
INSERT INTO journey_checklist_translations
  (topic_id, locale, display_label, short_description,
   explanation_what_it_is, explanation_user_benefit, explanation_when_to_use, explanation_try_this)
VALUES
  ('T251', 'en', 'Start Your Longevity Journey', 'This is where your journey begins – step by step.',
   'The beginning of your longevity journey – no pressure, one step at a time.',
   'You instantly know how your journey works and how to begin.',
   'Right now, as the very first step of your journey.',
   'Listen to Vitana, then start your first session.'),
  ('T252', 'en', 'Your Plan', 'How your journey finds the right next steps for you.',
   'Your personal plan for long-term health.',
   'You always know your next step – and why it matters.',
   'When you want to understand how your journey is built.',
   'Look at your plan and remember your next step.'),
  ('T253', 'en', 'Your First Step', 'Start small, keep going – that is how your journey becomes real.',
   'One small, clear action that supports your health.',
   'Intention turns into movement.',
   'Today – your first step can be small.',
   'Pick one simple action: more water, a short walk, or an earlier bedtime.'),
  ('T254', 'en', 'Your Progress', 'Progress means showing up, not being perfect.',
   'How your sessions turn into real progress.',
   'You see that every session is part of something bigger.',
   'When you want to see how far you have come.',
   'Complete this session and watch your progress grow.'),

  ('T251', 'es', 'Empieza tu viaje de longevidad', 'Aquí empieza tu viaje, paso a paso.',
   'El comienzo de tu viaje de longevidad, sin presión y paso a paso.',
   'Sabes de inmediato cómo funciona tu viaje y cómo empezar.',
   'Ahora mismo, como primer paso de tu viaje.',
   'Escucha a Vitana y luego empieza tu primera sesión.'),
  ('T252', 'es', 'Tu plan', 'Así tu viaje encuentra los próximos pasos adecuados para ti.',
   'Tu plan personal para una salud duradera.',
   'Siempre sabes cuál es tu próximo paso y por qué importa.',
   'Cuando quieras entender cómo está construido tu viaje.',
   'Mira tu plan y recuerda tu próximo paso.'),
  ('T253', 'es', 'Tu primer paso', 'Empieza poco a poco y sigue: así tu viaje se hace real.',
   'Una acción pequeña y clara que apoya tu salud.',
   'La intención se convierte en movimiento.',
   'Hoy: tu primer paso puede ser pequeño.',
   'Elige una acción sencilla: más agua, un paseo corto o acostarte antes.'),
  ('T254', 'es', 'Tu progreso', 'Progresar es seguir adelante, no ser perfecto.',
   'Así tus sesiones se convierten en progreso real.',
   'Ves que cada sesión es parte de algo más grande.',
   'Cuando quieras ver cuánto has avanzado.',
   'Completa esta sesión y mira crecer tu progreso.'),

  ('T251', 'sr', 'Započni svoje putovanje dugovečnosti', 'Ovde počinje tvoje putovanje – korak po korak.',
   'Početak tvog putovanja dugovečnosti – bez pritiska, korak po korak.',
   'Odmah znaš kako tvoje putovanje funkcioniše i kako da počneš.',
   'Odmah sada, kao prvi korak tvog putovanja.',
   'Saslušaj Vitanu, a zatim započni svoju prvu sesiju.'),
  ('T252', 'sr', 'Tvoj plan', 'Ovako tvoje putovanje pronalazi prave sledeće korake za tebe.',
   'Tvoj lični plan za dugoročno zdravlje.',
   'Uvek znaš svoj sledeći korak – i zašto je važan.',
   'Kada želiš da razumeš kako je tvoje putovanje izgrađeno.',
   'Pogledaj svoj plan i zapamti svoj sledeći korak.'),
  ('T253', 'sr', 'Tvoj prvi korak', 'Počni malim koracima i nastavi – tako tvoje putovanje postaje stvarno.',
   'Jedna mala, jasna akcija koja podržava tvoje zdravlje.',
   'Namera se pretvara u pokret.',
   'Danas – tvoj prvi korak može biti mali.',
   'Izaberi jednostavnu akciju: više vode, kratku šetnju ili raniji odlazak na spavanje.'),
  ('T254', 'sr', 'Tvoj napredak', 'Napredak znači istrajnost, ne savršenstvo.',
   'Ovako tvoje sesije postaju pravi napredak.',
   'Vidiš da je svaka sesija deo nečeg većeg.',
   'Kada želiš da vidiš koliko si već postigao.',
   'Završi ovu sesiju i gledaj kako tvoj napredak raste.')
ON CONFLICT (topic_id, locale) DO NOTHING;

-- 6. Rewrite the CURRENT published snapshot in place (sessions +4, four new
--    topics prepended) so the new opening is live without a manual re-publish.
--    "Publish = go live" still holds for future edits — this is a one-time,
--    deterministic structural rewrite of the same already-approved content.
UPDATE journey_checklist_versions v
SET snapshot = (
      SELECT jsonb_agg(
        jsonb_build_object(
          'topicId', t.topic_id, 'session', t.session, 'position', t.position,
          'chapterId', t.chapter_id, 'displayLabel', t.display_label,
          'shortDescription', t.short_description,
          'explanation', jsonb_build_object(
            'whatItIs', t.explanation_what_it_is, 'userBenefit', t.explanation_user_benefit,
            'whenToUse', t.explanation_when_to_use, 'tryThis', t.explanation_try_this),
          'guidedPracticeTarget', t.guided_practice_target, 'businessGate', t.business_gate,
          'vitanaVoiceScript', t.vitana_voice_script)
        ORDER BY t.session, t.position)
      FROM journey_checklist_topics t
      WHERE t.topic_id IN ('T251', 'T252', 'T253', 'T254')
    ) || (
      SELECT COALESCE(
        jsonb_agg(jsonb_set(e.elem, '{session}', to_jsonb(((e.elem->>'session')::int) + 4)) ORDER BY e.ord),
        '[]'::jsonb)
      FROM jsonb_array_elements(v.snapshot) WITH ORDINALITY AS e(elem, ord)
    ),
    session_count = v.session_count + 4,
    topic_count = v.topic_count + 4
WHERE v.is_current = true
  AND v.curriculum_version = 'v2'
  AND NOT v.snapshot @> '[{"topicId": "T251"}]'::jsonb;

INSERT INTO journey_checklist_audit (action, detail)
VALUES ('seed', 'BOOTSTRAP-FIRST-TIME-ONBOARDING: prepended onboarding sessions 1-4 (T251-T254), shifted existing curriculum to sessions 5-94, rewrote current snapshot in place');

COMMIT;
