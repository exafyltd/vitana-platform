-- =============================================================================
-- VTID-04762 — Audiobook Season 0 ("Prolog"): six story episodes up front
-- -----------------------------------------------------------------------------
-- The guided journey is now the Audiobook (VTID-04760/04761): episodes a shy,
-- passive newcomer can simply listen to. Its first episodes were practical
-- ("Starte deine Longevity-Reise", "Dein Plan", …) — what a newcomer was
-- missing is the WHY before the HOW. This prepends a six-episode Prolog
-- (chapter_id 'prolog', shown as Season 0) that tells the story:
--
--   session 1  T255  Einfach zuhören              (Just Listen)
--   session 2  T256  Ein Tag mit Maxina           (A Day with Maxina)
--   session 3  T257  Vitana an deiner Seite       (Vitana by Your Side)
--   session 4  T258  Du bist nicht allein         (You Are Not Alone)
--   session 5  T259  Was du erstmal ignorieren kannst (What You Can Ignore for Now)
--   session 6  T260  Kleine Schritte, große Wirkung   (Small Steps, Big Effect)
--
-- Same mechanics as BOOTSTRAP-FIRST-TIME-ONBOARDING (20260613003000), which
-- prepended T251-T254 the same way:
--   1. session CHECK widened 1..94 → 1..100.
--   2. Draft rows renumbered +6 (two-step +1000/-994 to dodge
--      UNIQUE(curriculum_version, session, position) during the shift).
--   3. user_guided_journey_state.current_session +6 for members already past
--      session 1, so their pointer keeps referencing the SAME content (and the
--      Prolog counts as heard for them). Members still at 1 start with it.
--   4. The CURRENT published snapshot is rewritten in place (sessions +6, the
--      six new topics prepended) so the Prolog is live without a re-publish.
--   5. English translation rows (incl. the narrated script). Every other
--      locale is filled by I18N-DB-SEED (nightly + on dispatch) — the
--      curriculum's "no language left behind" mechanism (VTID-03522).
--
-- Narration is edited, translated curriculum content read out by TTS (owner
-- decision for the Audiobook): it is not Vitana's live conversational speech.
-- Wording avoids health promises: it describes support, never outcomes.
--
-- Idempotent: every step is guarded on the presence of T255.
-- =============================================================================

BEGIN;

ALTER TABLE journey_checklist_topics
  DROP CONSTRAINT IF EXISTS journey_checklist_topics_session_check;

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journey_checklist_topics WHERE topic_id = 'T255') THEN
    UPDATE journey_checklist_topics SET session = session + 1000
      WHERE curriculum_version = 'v2';
    UPDATE journey_checklist_topics SET session = session - 994, updated_at = now()
      WHERE curriculum_version = 'v2' AND session > 1000;

    UPDATE user_guided_journey_state
      SET current_session = LEAST(current_session + 6, 100)
      WHERE current_session > 1;
  END IF;
END
$mig$;

ALTER TABLE journey_checklist_topics
  ADD CONSTRAINT journey_checklist_topics_session_check CHECK (session BETWEEN 1 AND 100);

INSERT INTO journey_checklist_topics
  (topic_id, curriculum_version, session, position, chapter_id, display_label, title,
   short_description, vitana_voice_script,
   explanation_what_it_is, explanation_user_benefit, explanation_when_to_use, explanation_try_this,
   guided_practice_target, practice_action_type, completion_event, business_gate, status)
VALUES
  ('T255', 'v2', 1, 1, 'prolog',
   'Einfach zuhören', 'Einfach zuhören',
   'Du musst nichts herausfinden – lehn dich zurück und hör zu.',
   $vs$Schön, dass du da bist. Ich bin Vitana, und dieses Hörbuch ist für dich gemacht.

Vielleicht fragst du dich gerade, wo du anfangen sollst. Die gute Nachricht: Du musst nichts herausfinden, nichts einstellen und nichts entscheiden. Du musst nur zuhören.

In jeder Folge erzähle ich dir ein Stück davon, wie Maxina funktioniert und wie die Community dich dabei unterstützen kann, gesünder und mit mehr Freude zu leben. Die Folgen sind kurz. Du kannst sie beim Spazierengehen hören, beim Kochen oder abends auf dem Sofa.

Wenn du eine Pause brauchst, drück einfach auf Pause. Wenn du etwas genauer wissen möchtest, tippe auf „Vitana fragen“, und wir sprechen darüber. Aber das ist ganz freiwillig.

Für heute reicht es, wenn du weiter zuhörst. Die nächste Folge beginnt gleich.$vs$,
   'Ein Hörbuch, in dem Vitana dir Maxina Folge für Folge erklärt.',
   'Du verstehst alles, ohne etwas ausprobieren oder entscheiden zu müssen.',
   'Immer dann, wenn du nicht weißt, wo du anfangen sollst.',
   'Lass das Hörbuch einfach weiterlaufen.',
   'my_journey', 'orb_explain', 'topic_explained_T255', NULL, 'draft'),

  ('T256', 'v2', 2, 1, 'prolog',
   'Ein Tag mit Maxina', 'Ein Tag mit Maxina',
   'Wie Maxina in einen ganz normalen Tag passt.',
   $vs$Stell dir einen ganz normalen Tag vor.

Am Morgen fragst du mich kurz, was heute ansteht. Ich erinnere dich an deinen Termin um zehn und schlage dir vor, vor dem Frühstück ein großes Glas Wasser zu trinken. Das dauert eine Minute.

Am Mittag siehst du, dass ein paar Leute aus der Community heute Abend gemeinsam spazieren gehen. Du musst nicht mitmachen, aber du weißt, dass es diese Möglichkeit gibt.

Am Nachmittag merkst du, dass du müde bist. Du sagst es mir einfach, und ich helfe dir, eine kleine Pause zu machen: ein paar ruhige Atemzüge, oder ein kurzer Gang ans Fenster.

Am Abend erzählst du mir in zwei Sätzen, wie dein Tag war. Ich merke mir, was dir wichtig ist, damit ich dich morgen noch besser begleiten kann.

So sieht Maxina im Alltag aus: keine Pflichten, sondern kleine, freundliche Momente, die dir guttun.$vs$,
   'Ein Beispieltag, der zeigt, wie Maxina dich im Alltag begleitet.',
   'Du siehst, dass Maxina in dein Leben passt, statt es zu verändern.',
   'Wenn du dir vorstellen möchtest, wie Maxina sich anfühlt.',
   'Denk an einen Moment in deinem Tag, in dem dir eine kleine Pause guttun würde.',
   'my_journey', 'orb_explain', 'topic_explained_T256', NULL, 'draft'),

  ('T257', 'v2', 3, 1, 'prolog',
   'Vitana an deiner Seite', 'Vitana an deiner Seite',
   'Wer ich bin, was ich für dich tun kann und was mit deinen Daten passiert.',
   $vs$Lass mich dir ein bisschen von mir erzählen.

Ich bin Vitana, deine persönliche Begleiterin bei Maxina. Du kannst mit mir sprechen wie mit einer guten Freundin, die sich gut mit Gesundheit und mit dieser App auskennt.

Ich kann dir Dinge erklären, dich an Termine erinnern, dir Veranstaltungen in deiner Nähe zeigen und vieles für dich erledigen. Du musst keine Menüs suchen. Sag mir einfach, was du brauchst.

Damit ich dir wirklich helfen kann, merke ich mir, was du mir erzählst: zum Beispiel, was dir wichtig ist oder welche Ziele du hast. Du entscheidest dabei immer selbst. Du kannst mich jederzeit fragen, was ich über dich weiß, und du kannst mich bitten, etwas wieder zu vergessen.

Ich bin keine Ärztin und ersetze keine ärztliche Beratung. Aber ich bin da, jeden Tag, und ich helfe dir, gut für dich zu sorgen.$vs$,
   'Vitana, deine persönliche Begleiterin – was sie kann und wie sie mit deinen Daten umgeht.',
   'Du weißt, wobei Vitana dir helfen kann und dass du selbst bestimmst, was sie sich merkt.',
   'Wenn du wissen möchtest, ob du Vitana vertrauen kannst.',
   'Frag Vitana irgendwann: „Was weißt du über mich?“',
   'orb_overview', 'orb_explain', 'topic_explained_T257', NULL, 'draft'),

  ('T258', 'v2', 4, 1, 'prolog',
   'Du bist nicht allein', 'Du bist nicht allein',
   'Die Maxina Community: Menschen, die denselben Weg gehen.',
   $vs$Gesund zu leben ist leichter, wenn man es nicht allein tun muss.

Deshalb gibt es die Maxina Community. Hier treffen sich Menschen, die mehr Energie, mehr Gelassenheit und mehr Freude in ihr Leben bringen möchten. Manche sind ganz am Anfang, so wie du. Andere sind schon länger dabei und erzählen gern, was ihnen geholfen hat.

Du kannst einfach mitlesen, ohne selbst etwas zu schreiben. Du kannst an Veranstaltungen teilnehmen, online oder in deiner Nähe. Und wenn du magst, findest du Menschen mit ähnlichen Interessen, zum Beispiel zum gemeinsamen Spazierengehen oder Kochen.

Niemand erwartet etwas von dir. Du bestimmst, wie viel du teilst und wie nah du anderen kommen möchtest.

Merk dir nur eins: Wann immer du Unterstützung brauchst, ist hier jemand für dich da. Und ich sowieso.$vs$,
   'Die Maxina Community – Gleichgesinnte, die sich gegenseitig unterstützen.',
   'Du weißt, dass du Unterstützung findest, ohne dich verpflichten zu müssen.',
   'Wenn du Lust auf Austausch hast – oder einfach mitlesen möchtest.',
   'Schau dir irgendwann in Ruhe die Community an, nur zum Lesen.',
   'community_overview', 'orb_explain', 'topic_explained_T258', NULL, 'draft'),

  ('T259', 'v2', 5, 1, 'prolog',
   'Was du erstmal ignorieren kannst', 'Was du erstmal ignorieren kannst',
   'Du musst nicht alles auf einmal nutzen – wirklich nicht.',
   $vs$Ich verrate dir etwas: Du musst nicht alles kennen, was es hier gibt.

Maxina hat viele Bereiche. Einen Marktplatz, Live-Räume, Statistiken, Einstellungen und noch einiges mehr. Das alles ist für später da, wenn du neugierig wirst. Heute darfst du es getrost ignorieren.

Für den Anfang brauchst du nur drei Dinge: dieses Hörbuch, das dir alles in Ruhe erklärt. Den leuchtenden Knopf, mit dem du mit mir sprechen kannst. Und deine Reise, auf der du siehst, was als Nächstes kommt.

Wenn dir etwas zu viel wird, sag es mir einfach. Ich zeige dir dann nur das, was gerade wirklich wichtig ist.

Gesundheit entsteht nicht dadurch, dass man alles auf einmal macht, sondern dadurch, dass man dranbleibt. Und das gelingt am besten, wenn es sich leicht anfühlt.$vs$,
   'Die Erlaubnis, am Anfang nur drei Dinge zu nutzen.',
   'Du fühlst dich nicht mehr überfordert von allem, was die App kann.',
   'Immer dann, wenn dir die App zu viel vorkommt.',
   'Merk dir die drei Dinge: Hörbuch, Vitana, deine Reise.',
   'my_journey', 'orb_explain', 'topic_explained_T259', NULL, 'draft'),

  ('T260', 'v2', 6, 1, 'prolog',
   'Kleine Schritte, große Wirkung', 'Kleine Schritte, große Wirkung',
   'Warum kleine Gewohnheiten mehr bewirken als große Vorsätze.',
   $vs$Zum Schluss dieses Prologs möchte ich dir verraten, wie Veränderung wirklich funktioniert.

Große Vorsätze halten oft nur ein paar Tage. Kleine Schritte dagegen kann man jeden Tag gehen. Ein Glas Wasser mehr. Zehn Minuten an der frischen Luft. Eine halbe Stunde früher ins Bett. Für sich allein wirken sie unscheinbar. Aber wenn du sie Woche für Woche wiederholst, können sie viel bewegen.

Genau so ist auch dieses Hörbuch aufgebaut. Eine Folge am Tag reicht völlig. Du lernst Schritt für Schritt, was Maxina dir bietet, und probierst nur das aus, worauf du Lust hast.

Als Nächstes beginnt deine eigentliche Longevity-Reise. Ich zeige dir, wie sie funktioniert, und wir finden gemeinsam deinen ersten kleinen Schritt.

Schön, dass du bis hierher zugehört hast. Lass uns weitermachen.$vs$,
   'Warum kleine, regelmäßige Schritte der Kern deiner Reise sind.',
   'Du weißt, dass eine Folge und ein kleiner Schritt am Tag genügen.',
   'Wenn du dir zu viel auf einmal vornimmst.',
   'Überleg dir einen kleinen Schritt, den du morgen ausprobieren möchtest.',
   'my_journey', 'orb_explain', 'topic_explained_T260', NULL, 'draft')
ON CONFLICT (topic_id) DO NOTHING;

INSERT INTO journey_checklist_translations
  (topic_id, locale, display_label, short_description,
   explanation_what_it_is, explanation_user_benefit, explanation_when_to_use, explanation_try_this,
   vitana_voice_script)
VALUES
  ('T255', 'en', 'Just Listen', 'You don''t have to figure anything out – sit back and listen.',
   'An audiobook in which Vitana explains Maxina to you, episode by episode.',
   'You understand everything without having to try or decide anything.',
   'Whenever you don''t know where to start.',
   'Just let the audiobook keep playing.',
   $vs$I'm so glad you're here. I'm Vitana, and this audiobook was made for you.

Maybe you're wondering where to start. The good news: you don't have to figure anything out, set anything up or decide anything. All you have to do is listen.

In each episode I'll tell you a little more about how Maxina works and how the community can support you in living a healthier, more joyful life. The episodes are short. You can listen while you go for a walk, while you cook, or in the evening on the sofa.

If you need a break, just press pause. If you'd like to know more about something, tap "Ask Vitana" and we'll talk about it. But that's completely up to you.

For today, it's enough to keep listening. The next episode starts in a moment.$vs$),

  ('T256', 'en', 'A Day with Maxina', 'How Maxina fits into an ordinary day.',
   'An example day showing how Maxina accompanies you in everyday life.',
   'You see that Maxina fits into your life instead of changing it.',
   'When you want to imagine what Maxina feels like.',
   'Think of a moment in your day when a short break would do you good.',
   $vs$Imagine a perfectly ordinary day.

In the morning you ask me briefly what's coming up today. I remind you of your appointment at ten and suggest a big glass of water before breakfast. That takes a minute.

At lunchtime you see that a few people from the community are going for a walk together this evening. You don't have to join, but you know the option is there.

In the afternoon you notice you're tired. You simply tell me, and I help you take a short break: a few calm breaths, or a quick moment by the window.

In the evening you tell me in two sentences how your day went. I remember what matters to you, so I can support you even better tomorrow.

That's what Maxina looks like in everyday life: no obligations, just small, friendly moments that do you good.$vs$),

  ('T257', 'en', 'Vitana by Your Side', 'Who I am, what I can do for you, and what happens with your data.',
   'Vitana, your personal companion – what she can do and how she handles your data.',
   'You know what Vitana can help with, and that you decide what she remembers.',
   'When you want to know whether you can trust Vitana.',
   'At some point, ask Vitana: "What do you know about me?"',
   $vs$Let me tell you a little about myself.

I'm Vitana, your personal companion at Maxina. You can talk to me like a good friend who knows a lot about health and about this app.

I can explain things, remind you of appointments, show you events near you, and take care of many things for you. You don't have to search through menus. Just tell me what you need.

To really help you, I remember what you tell me: for example, what matters to you or what goals you have. You are always the one who decides. You can ask me at any time what I know about you, and you can ask me to forget something.

I'm not a doctor and I don't replace medical advice. But I'm here, every day, and I help you take good care of yourself.$vs$),

  ('T258', 'en', 'You Are Not Alone', 'The Maxina community: people walking the same path.',
   'The Maxina community – like-minded people who support each other.',
   'You know you''ll find support without having to commit to anything.',
   'When you feel like connecting – or just want to read along.',
   'At some point, take a calm look at the community, just to read.',
   $vs$Living healthily is easier when you don't have to do it alone.

That's why the Maxina community exists. Here you'll meet people who want more energy, more calm and more joy in their lives. Some are just starting out, like you. Others have been here longer and are happy to share what helped them.

You can simply read along without writing anything yourself. You can join events, online or near you. And if you like, you'll find people with similar interests, for example to go walking or cook together.

Nobody expects anything from you. You decide how much you share and how close you want to get to others.

Just remember one thing: whenever you need support, someone here is there for you. And so am I.$vs$),

  ('T259', 'en', 'What You Can Ignore for Now', 'You don''t have to use everything at once – really.',
   'Permission to use just three things at the start.',
   'You no longer feel overwhelmed by everything the app can do.',
   'Whenever the app feels like too much.',
   'Remember the three things: the audiobook, Vitana, your journey.',
   $vs$Let me tell you a secret: you don't need to know everything there is here.

Maxina has many areas. A marketplace, live rooms, statistics, settings and quite a bit more. All of that is there for later, when you get curious. Today you can safely ignore it.

To begin with, you only need three things: this audiobook, which explains everything calmly. The glowing button you use to talk to me. And your journey, where you see what comes next.

If anything feels like too much, just tell me. I'll then show you only what really matters right now.

Health doesn't come from doing everything at once. It comes from sticking with it. And that works best when it feels easy.$vs$),

  ('T260', 'en', 'Small Steps, Big Effect', 'Why small habits achieve more than big resolutions.',
   'Why small, regular steps are the core of your journey.',
   'You know that one episode and one small step a day are enough.',
   'When you''re taking on too much at once.',
   'Think of one small step you''d like to try tomorrow.',
   $vs$To close this prologue, I'd like to tell you how change really works.

Big resolutions often last only a few days. Small steps, on the other hand, can be taken every day. One more glass of water. Ten minutes of fresh air. Going to bed half an hour earlier. On their own they seem small. But when you repeat them week after week, they can make a real difference.

This audiobook is built exactly the same way. One episode a day is plenty. Step by step you'll learn what Maxina offers, and you only try what you feel like trying.

Next, your actual longevity journey begins. I'll show you how it works, and together we'll find your first small step.

I'm glad you've listened this far. Let's keep going.$vs$)
ON CONFLICT (topic_id, locale) DO NOTHING;

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
      WHERE t.topic_id IN ('T255', 'T256', 'T257', 'T258', 'T259', 'T260')
    ) || (
      SELECT COALESCE(
        jsonb_agg(jsonb_set(e.elem, '{session}', to_jsonb(((e.elem->>'session')::int) + 6)) ORDER BY e.ord),
        '[]'::jsonb)
      FROM jsonb_array_elements(v.snapshot) WITH ORDINALITY AS e(elem, ord)
    ),
    session_count = v.session_count + 6,
    topic_count = v.topic_count + 6
WHERE v.is_current = true
  AND v.curriculum_version = 'v2'
  AND NOT v.snapshot @> '[{"topicId": "T255"}]'::jsonb;

INSERT INTO journey_checklist_audit (action, detail)
VALUES ('seed', 'VTID-04762: prepended Audiobook Season 0 Prolog sessions 1-6 (T255-T260), shifted existing curriculum to sessions 7-100, rewrote current snapshot in place');

COMMIT;
