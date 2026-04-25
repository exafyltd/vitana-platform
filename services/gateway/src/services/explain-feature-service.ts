/**
 * Explain-Feature Service (BOOTSTRAP-TEACH-BEFORE-REDIRECT Phase 1).
 *
 * The voice-runtime side of the "Teach before redirect" plan. Maps a
 * free-text topic from the user's question to a canonical how-to entry
 * and returns the structured payload voice consumes.
 *
 * Why a TS map instead of parsing markdown frontmatter at runtime:
 *   - Deterministic, fast (~1ms vs DB query + parse).
 *   - Type-safe — the override prompt's contract is enforced by the type.
 *   - The accompanying KB docs (seeded by migration) are for users to
 *     browse / cite via search_knowledge. The TS map is for voice runtime.
 *   - Two surfaces for the same content is a feature, not a bug: KB is
 *     long-form prose for tap-through reading; this service is the short
 *     spoken instruction. Single underlying topic, two presentations.
 *
 * If a topic doesn't match any pattern, returns { found: false } and the
 * override prompt instructs voice to fall back to search_knowledge.
 */

import type { PillarKey } from '../lib/vitana-pillars';

export interface ExplainFeatureResult {
  found: boolean;
  topic_canonical?: string;
  pillar_lift?: PillarKey;
  summary_voice_en?: string;
  summary_voice_de?: string;
  steps_voice_en?: string[];
  steps_voice_de?: string[];
  redirect_route?: string;        // e.g. '/journal' or '/health'
  redirect_offer_en?: string;
  redirect_offer_de?: string;
  citation?: string;              // KB doc path for tap-through
  reason?: string;                // populated when found=false
}

interface TopicEntry {
  canonical: string;
  patterns: RegExp[];
  pillar?: PillarKey;
  summary_voice_en: string;
  summary_voice_de: string;
  steps_voice_en: string[];
  steps_voice_de: string[];
  redirect_route?: string;
  redirect_offer_en: string;
  redirect_offer_de: string;
  citation: string;
}

/**
 * The canonical how-to topic library. Order matters — the first matching
 * entry wins. Put more-specific patterns above more-general ones.
 *
 * Companion KB docs (same canonical names, kb/vitana-system/how-to/<X>.md)
 * are seeded via supabase/migrations/<timestamp>_how_to_kb_corpus.sql so
 * search_knowledge can also surface long-form versions.
 */
const TOPIC_LIBRARY: readonly TopicEntry[] = [
  // ─── Manual logging — per pillar ───
  {
    canonical: 'log_hydration_manually',
    patterns: [
      /\b(log|track|enter|record|dictate|input)\b.*\b(hydration|water|drink|fluid)\b/i,
      /\b(hydration|water|drink|fluid)\b.*\b(log|track|enter|record|manually|by hand)\b/i,
      /how (do|can) i (log|track|enter|record).*water/i,
      /wie (kann|mache) ich.*wasser.*ein/i,
      /\b(wasser|hydration|trinken)\b.*\b(eintragen|protokollieren|erfassen)\b/i,
    ],
    pillar: 'hydration',
    summary_voice_en: "You log hydration by speaking into your Daily Diary. The system listens for phrases like 'I drank a glass of water' and turns them into a hydration entry that lifts your Hydration pillar.",
    summary_voice_de: "Du protokollierst Hydration, indem du ins Daily Diary sprichst. Sätze wie 'Ich habe ein Glas Wasser getrunken' werden automatisch erfasst und heben deine Hydration-Säule.",
    steps_voice_en: [
      "First, open Daily Diary from the bottom navigation.",
      "Tap the microphone button.",
      "Say something natural, like 'I drank 500 millilitres of water this morning'.",
      "Tap done. The system parses your sentence into a hydration log automatically.",
      "Your Hydration pillar updates within a few minutes.",
    ],
    steps_voice_de: [
      "Öffne zuerst Daily Diary in der unteren Navigation.",
      "Tippe auf das Mikrofon-Symbol.",
      "Sag etwas Natürliches wie 'Ich habe heute Morgen 500 Milliliter Wasser getrunken'.",
      "Tippe auf Fertig. Das System wandelt deinen Satz automatisch in einen Hydration-Eintrag um.",
      "Deine Hydration-Säule aktualisiert sich innerhalb weniger Minuten.",
    ],
    redirect_route: '/daily-diary',
    redirect_offer_en: "Want me to open Daily Diary so you can dictate it now?",
    redirect_offer_de: "Soll ich dir Daily Diary öffnen, damit du es jetzt diktieren kannst?",
    citation: 'kb/vitana-system/how-to/log-hydration-manually.md',
  },
  {
    canonical: 'log_nutrition_manually',
    patterns: [
      /\b(log|track|enter|record|dictate|input)\b.*\b(nutrition|food|meal|eating|ate|breakfast|lunch|dinner)\b/i,
      /\b(nutrition|food|meal|eating)\b.*\b(log|track|enter|record|manually|by hand)\b/i,
      /how (do|can) i (log|track|enter|record).*(food|meal|nutrition)/i,
      /wie (kann|mache) ich.*(essen|mahlzeit|ernährung).*ein/i,
      /\b(essen|mahlzeit|ernährung|frühstück|mittag|abendessen)\b.*\b(eintragen|protokollieren|erfassen)\b/i,
    ],
    pillar: 'nutrition',
    summary_voice_en: "You log meals by dictating into Daily Diary. Describe what you ate naturally and the system records it as a nutrition entry that feeds your Nutrition pillar.",
    summary_voice_de: "Du protokollierst Mahlzeiten, indem du sie ins Daily Diary diktierst. Beschreibe natürlich, was du gegessen hast — der Eintrag fließt in deine Nutrition-Säule ein.",
    steps_voice_en: [
      "Open Daily Diary.",
      "Tap the microphone.",
      "Describe your meal naturally, like 'I had oatmeal with berries and a coffee for breakfast'.",
      "Save the entry. The system parses it into a nutrition log.",
      "Your Nutrition pillar updates within a few minutes.",
    ],
    steps_voice_de: [
      "Öffne Daily Diary.",
      "Tippe auf das Mikrofon.",
      "Beschreibe deine Mahlzeit natürlich, zum Beispiel 'Ich hatte Haferflocken mit Beeren und einen Kaffee zum Frühstück'.",
      "Speichere den Eintrag. Das System wandelt ihn in einen Nutrition-Eintrag um.",
      "Deine Nutrition-Säule aktualisiert sich in wenigen Minuten.",
    ],
    redirect_route: '/daily-diary',
    redirect_offer_en: "Want me to open Daily Diary now?",
    redirect_offer_de: "Soll ich dir Daily Diary jetzt öffnen?",
    citation: 'kb/vitana-system/how-to/log-nutrition-manually.md',
  },
  {
    canonical: 'log_exercise_manually',
    patterns: [
      /\b(log|track|enter|record|dictate|input)\b.*\b(exercise|workout|movement|walk|run|cardio|gym|training)\b/i,
      /\b(exercise|workout|walk|run|gym)\b.*\b(log|track|enter|record|manually|by hand)\b/i,
      /how (do|can) i (log|track|enter|record).*(exercise|workout|run|walk)/i,
      /wie (kann|mache) ich.*(bewegung|sport|training|workout|laufen).*ein/i,
      /\b(bewegung|sport|training|workout|laufen|gehen)\b.*\b(eintragen|protokollieren|erfassen)\b/i,
    ],
    pillar: 'exercise',
    summary_voice_en: "You log workouts by dictating them into Daily Diary. Connecting a tracker like Apple Health is the richer path, but for one-off sessions or when no tracker is on, dictation works.",
    summary_voice_de: "Du protokollierst Workouts, indem du sie ins Daily Diary diktierst. Ein Tracker wie Apple Health ist der detailliertere Weg, aber für einmalige Sessions reicht das Diktat.",
    steps_voice_en: [
      "Open Daily Diary.",
      "Tap the microphone.",
      "Describe what you did, like 'I walked 30 minutes this morning' or 'I did a 45-minute strength workout at the gym'.",
      "Save. The system logs it for your Exercise pillar.",
    ],
    steps_voice_de: [
      "Öffne Daily Diary.",
      "Tippe auf das Mikrofon.",
      "Beschreibe, was du gemacht hast, zum Beispiel 'Ich bin heute Morgen 30 Minuten gelaufen' oder 'Ich hatte ein 45-minütiges Krafttraining im Studio'.",
      "Speichern. Das System protokolliert es für deine Exercise-Säule.",
    ],
    redirect_route: '/daily-diary',
    redirect_offer_en: "Want me to open Daily Diary now?",
    redirect_offer_de: "Soll ich dir Daily Diary jetzt öffnen?",
    citation: 'kb/vitana-system/how-to/log-exercise-manually.md',
  },
  {
    canonical: 'log_sleep_manually',
    patterns: [
      /\b(log|track|enter|record|dictate|input)\b.*\b(sleep|bedtime|rest|recovery)\b/i,
      /\b(sleep|bedtime|rest)\b.*\b(log|track|enter|record|manually|by hand)\b/i,
      /how (do|can) i (log|track|enter|record).*sleep/i,
      /wie (kann|mache) ich.*(schlaf|schlafen).*ein/i,
      /\b(schlaf|schlafen|bettzeit)\b.*\b(eintragen|protokollieren|erfassen)\b/i,
    ],
    pillar: 'sleep',
    summary_voice_en: "You log sleep by dictating into Daily Diary in the morning. A sleep tracker is more accurate, but a quick voice note works fine for the Sleep pillar baseline.",
    summary_voice_de: "Du protokollierst Schlaf, indem du morgens ins Daily Diary sprichst. Ein Schlaf-Tracker ist genauer, aber eine kurze Sprachnotiz reicht für die Sleep-Säule.",
    steps_voice_en: [
      "In the morning, open Daily Diary.",
      "Tap the microphone.",
      "Say something like 'I slept from 11 PM to 6:30 AM, woke up rested'.",
      "Save. The system records it for your Sleep pillar.",
    ],
    steps_voice_de: [
      "Öffne Daily Diary morgens.",
      "Tippe auf das Mikrofon.",
      "Sag zum Beispiel 'Ich habe von 23 Uhr bis 6:30 Uhr geschlafen und bin ausgeruht aufgewacht'.",
      "Speichern. Das System erfasst es für deine Sleep-Säule.",
    ],
    redirect_route: '/daily-diary',
    redirect_offer_en: "Want me to open Daily Diary now?",
    redirect_offer_de: "Soll ich dir Daily Diary jetzt öffnen?",
    citation: 'kb/vitana-system/how-to/log-sleep-manually.md',
  },
  {
    canonical: 'log_mental_state_manually',
    patterns: [
      /\b(log|track|enter|record|dictate|input)\b.*\b(mental|mood|stress|feeling|emotion|journaling)\b/i,
      /\b(mental|mood|stress|feeling)\b.*\b(log|track|enter|record|manually)\b/i,
      /how (do|can) i (log|track|record).*(mood|stress|mental|feeling)/i,
      /wie (kann|mache) ich.*(stimmung|gefühl|stress|mental).*ein/i,
      /\b(stimmung|gefühl|stress|mental)\b.*\b(eintragen|protokollieren|erfassen)\b/i,
    ],
    pillar: 'mental',
    summary_voice_en: "You log how you feel — mood, stress, what's on your mind — by dictating into Daily Diary. Even a sentence helps; the system extracts your mental state to feed the Mental pillar.",
    summary_voice_de: "Du protokollierst, wie du dich fühlst — Stimmung, Stress, Gedanken — indem du ins Daily Diary diktierst. Schon ein Satz hilft; das System erfasst deinen Zustand für die Mental-Säule.",
    steps_voice_en: [
      "Open Daily Diary.",
      "Tap the microphone.",
      "Say what's on your mind, like 'feeling a bit stressed about the meeting today, took 10 minutes to meditate this morning'.",
      "Save. The system records it for your Mental pillar.",
    ],
    steps_voice_de: [
      "Öffne Daily Diary.",
      "Tippe auf das Mikrofon.",
      "Sag, was dir durch den Kopf geht, zum Beispiel 'Ich bin etwas gestresst wegen des Meetings heute, habe heute Morgen 10 Minuten meditiert'.",
      "Speichern. Das System erfasst es für deine Mental-Säule.",
    ],
    redirect_route: '/daily-diary',
    redirect_offer_en: "Want me to open Daily Diary now?",
    redirect_offer_de: "Soll ich dir Daily Diary jetzt öffnen?",
    citation: 'kb/vitana-system/how-to/log-mental-state-manually.md',
  },

  // ─── Foundational how-tos ───
  {
    canonical: 'use_daily_diary_dictation',
    patterns: [
      /\b(how|what|tell me about).*(daily diary|diary|journal)\b/i,
      /\b(daily diary|diary)\b.*\b(work|use|dictat|speak)\b/i,
      /wie (funktioniert|nutze ich).*(daily diary|tagebuch)/i,
      /\b(daily diary|tagebuch)\b.*\b(funktioniert|nutzen|diktieren)\b/i,
    ],
    summary_voice_en: "Daily Diary is the single voice-first surface for everything you can't measure with a sensor. You speak; the system parses your words into health entries (food, water, exercise, sleep, mood) and saves them as a personal log. It's the manual counterpart to your trackers.",
    summary_voice_de: "Daily Diary ist die zentrale Sprachoberfläche für alles, was kein Sensor messen kann. Du sprichst; das System wandelt deine Worte in Gesundheitseinträge um — Essen, Wasser, Bewegung, Schlaf, Stimmung — und speichert sie als persönliches Protokoll.",
    steps_voice_en: [
      "Open Daily Diary from the bottom navigation.",
      "Tap the microphone to start dictation.",
      "Speak naturally — full sentences are fine. You can mention multiple things in one entry.",
      "Tap done. The system saves your entry and feeds the relevant pillars of your Vitana Index.",
      "You can dictate multiple times a day — morning, midday, evening — to keep your day captured.",
    ],
    steps_voice_de: [
      "Öffne Daily Diary in der unteren Navigation.",
      "Tippe auf das Mikrofon, um die Diktatfunktion zu starten.",
      "Sprich natürlich — ganze Sätze sind in Ordnung. Du kannst mehrere Dinge in einem Eintrag erwähnen.",
      "Tippe auf Fertig. Das System speichert deinen Eintrag und versorgt die passenden Säulen deines Vitana-Index.",
      "Du kannst mehrmals am Tag diktieren — morgens, mittags, abends — um deinen Tag festzuhalten.",
    ],
    redirect_route: '/daily-diary',
    redirect_offer_en: "Want me to open Daily Diary so you can try it now?",
    redirect_offer_de: "Soll ich dir Daily Diary öffnen, damit du es jetzt ausprobieren kannst?",
    citation: 'kb/vitana-system/how-to/use-daily-diary-dictation.md',
  },
  {
    canonical: 'connect_health_tracker',
    patterns: [
      /\b(connect|link|pair|integrate|set up|setup|sync)\b.*\b(tracker|wearable|apple health|google fit|oura|whoop|fitbit|garmin)\b/i,
      /\b(tracker|wearable|apple health|oura|whoop|fitbit)\b.*\b(connect|link|pair|set up|setup|sync)\b/i,
      /how (do|can) i (connect|link|sync).*(tracker|apple health|oura)/i,
      /wie (kann|mache) ich.*(tracker|apple health|oura).*verbind/i,
      /\b(verbinden|koppeln|einrichten)\b.*\b(tracker|wearable|apple health|oura|whoop)\b/i,
    ],
    summary_voice_en: "Connecting a health tracker would be the richer path — once paired, it would feed your Vitana pillars automatically every day. Right now native OAuth for partners like Apple Health, Oura and Whoop is still on the roadmap, so the consumer connect-flow isn't live yet. In the meantime, manual dictation into Daily Diary is the working path for every pillar.",
    summary_voice_de: "Einen Health-Tracker zu verbinden wäre der detailliertere Weg — einmal gekoppelt, würde er deine Vitana-Säulen automatisch täglich versorgen. Aktuell ist die native Anbindung für Partner wie Apple Health, Oura und Whoop noch in Arbeit, der Verbraucher-Flow ist also noch nicht live. Bis dahin ist die manuelle Diktatfunktion in Daily Diary der Weg für jede Säule.",
    steps_voice_en: [
      "There isn't a one-tap connect screen yet — partner OAuth is on the roadmap.",
      "For now, dictate your daily activity into Daily Diary — the system extracts hydration, meals, sleep and movement from your words and feeds the pillars.",
      "When Apple Health, Oura, Whoop and others go live, you'll see them in your settings as a one-tap option, and your Index will start drawing from the live data automatically.",
    ],
    steps_voice_de: [
      "Es gibt noch keinen 1-Klick-Verbindungs-Bildschirm — die Partner-Anbindungen sind in Vorbereitung.",
      "Bis dahin diktiere deine tägliche Aktivität ins Daily Diary — das System erkennt Hydration, Mahlzeiten, Schlaf und Bewegung aus deinen Worten und versorgt die Säulen.",
      "Sobald Apple Health, Oura, Whoop und andere live gehen, erscheinen sie als 1-Klick-Option in deinen Einstellungen, und dein Index zieht dann automatisch Live-Daten.",
    ],
    // No community-facing integrations route yet — admin-only screen.
    // Fall back to Daily Diary as the working alternative the user can
    // act on right now. When partner OAuth ships, change to a real
    // integrations route and update redirect_offer text.
    redirect_route: '/daily-diary',
    redirect_offer_en: "Want me to open Daily Diary so you can dictate your activity in the meantime?",
    redirect_offer_de: "Soll ich dir Daily Diary öffnen, damit du in der Zwischenzeit dein Tagesgeschehen diktieren kannst?",
    citation: 'kb/vitana-system/how-to/connect-health-tracker.md',
  },
  {
    canonical: 'improve_your_vitana_index',
    patterns: [
      /how (do|can) i (improve|raise|lift|boost|grow).*(vitana )?(index|score)/i,
      /\bimprove (my )?(vitana )?(index|score)\b/i,
      /wie (kann|verbessere) ich (meinen )?(vitana )?(index|score)/i,
      /\bverbess(er|ern)\b.*\b(vitana )?(index|score)\b/i,
    ],
    summary_voice_en: "Your Vitana Index moves when you do small daily things across the five pillars — Nutrition, Hydration, Exercise, Sleep, Mental — AND when you keep them in balance. The fastest lever is your weakest pillar; the second-fastest is logging consistently so the system has signal to score from.",
    summary_voice_de: "Dein Vitana-Index bewegt sich, wenn du kleine tägliche Dinge über die fünf Säulen verteilst — Nutrition, Hydration, Exercise, Sleep, Mental — UND sie im Gleichgewicht hältst. Der schnellste Hebel ist deine schwächste Säule; der zweitschnellste ist konsequentes Protokollieren.",
    steps_voice_en: [
      "Check your Index Detail screen — find your weakest pillar.",
      "Pick one small action for that pillar from the Autopilot suggestions, or dictate one entry into Daily Diary today.",
      "Repeat tomorrow. Streaks of 7 days lift sub-scores noticeably.",
      "Connect a tracker for one pillar — that's the biggest jump per setup minute.",
      "Keep balance: it's better to do 4-out-of-5 pillars at a moderate level than to max one and ignore the rest. The balance factor dampens lopsided scores.",
    ],
    steps_voice_de: [
      "Schau auf deinen Index-Detail-Screen — finde deine schwächste Säule.",
      "Wähle eine kleine Aktion für diese Säule aus den Autopilot-Vorschlägen oder diktiere heute einen Eintrag ins Daily Diary.",
      "Wiederhole es morgen. Streaks von 7 Tagen heben die Sub-Scores spürbar.",
      "Verbinde einen Tracker für eine Säule — das ist der größte Sprung pro Einrichtungsminute.",
      "Halte die Balance: 4 von 5 Säulen auf mittlerem Niveau ist besser als eine maximieren und den Rest ignorieren. Der Balance-Faktor dämpft einseitige Scores.",
    ],
    redirect_route: '/health/vitana-index',
    redirect_offer_en: "Want me to open your Index Detail screen so you can see where to start?",
    redirect_offer_de: "Soll ich dir den Index-Detail-Screen öffnen, damit du siehst, wo du anfangen kannst?",
    citation: 'kb/vitana-system/how-to/improve-your-vitana-index.md',
  },
  {
    canonical: 'what_is_autopilot',
    patterns: [
      /what (is|does) autopilot/i,
      /how (does )?autopilot work/i,
      /tell me about autopilot/i,
      /(explain|teach me) autopilot/i,
      /was (ist|macht) autopilot/i,
      /wie funktioniert autopilot/i,
      /erkläre.*autopilot/i,
    ],
    summary_voice_en: "Autopilot is the engine that watches your Vitana Index and suggests the next small action that would lift it the most. It ranks suggestions by which pillar needs the most help and how much each action would move you. You activate, you complete, you climb.",
    summary_voice_de: "Autopilot ist die Engine, die deinen Vitana-Index beobachtet und die nächste kleine Aktion vorschlägt, die ihn am meisten hebt. Sie bewertet Vorschläge danach, welche Säule am meisten Hilfe braucht und wie stark jede Aktion dich bewegen würde.",
    steps_voice_en: [
      "Open Autopilot from the home screen — you see a ranked list of suggestions.",
      "Each card shows which pillar it lifts (for example, Sleep +4) and roughly how long it takes.",
      "Activate one. The system schedules a calendar event for it.",
      "Complete the event. Your Index recomputes within minutes and the queue regenerates.",
      "Don't try to clear the whole list — pick one or two each day, balanced across pillars.",
    ],
    steps_voice_de: [
      "Öffne Autopilot vom Home-Screen — du siehst eine sortierte Liste von Vorschlägen.",
      "Jede Karte zeigt, welche Säule sie hebt (zum Beispiel Schlaf +4) und ungefähr wie lange es dauert.",
      "Aktiviere einen Vorschlag. Das System legt einen Kalender-Eintrag dafür an.",
      "Schließe den Eintrag ab. Dein Index wird innerhalb weniger Minuten neu berechnet und die Liste regeneriert.",
      "Versuche nicht, die ganze Liste abzuarbeiten — wähle ein bis zwei pro Tag, ausgewogen über die Säulen.",
    ],
    redirect_route: '/autopilot',
    redirect_offer_en: "Want me to open Autopilot now so you can see your suggestions?",
    redirect_offer_de: "Soll ich dir Autopilot jetzt öffnen, damit du deine Vorschläge siehst?",
    citation: 'kb/vitana-system/how-to/what-is-autopilot.md',
  },
] as const;

/**
 * Resolve a free-text topic to a canonical how-to entry. Returns
 * { found: false } when nothing matches — voice falls back to
 * search_knowledge per the override block instructions.
 */
export function explainFeature(topicText: string): ExplainFeatureResult {
  if (!topicText || typeof topicText !== 'string') {
    return { found: false, reason: 'empty_topic' };
  }
  const text = topicText.trim();
  for (const entry of TOPIC_LIBRARY) {
    if (entry.patterns.some(re => re.test(text))) {
      return {
        found: true,
        topic_canonical: entry.canonical,
        pillar_lift: entry.pillar,
        summary_voice_en: entry.summary_voice_en,
        summary_voice_de: entry.summary_voice_de,
        steps_voice_en: [...entry.steps_voice_en],
        steps_voice_de: [...entry.steps_voice_de],
        redirect_route: entry.redirect_route,
        redirect_offer_en: entry.redirect_offer_en,
        redirect_offer_de: entry.redirect_offer_de,
        citation: entry.citation,
      };
    }
  }
  return { found: false, reason: 'no_pattern_match' };
}

/**
 * Lightweight introspection — exposes the canonical topic list (without
 * patterns) for diagnostics endpoints / Command Hub. Order matches
 * resolution priority.
 */
export function listCanonicalTopics(): Array<{
  canonical: string;
  pillar?: PillarKey;
  citation: string;
  redirect_route?: string;
}> {
  return TOPIC_LIBRARY.map(t => ({
    canonical: t.canonical,
    pillar: t.pillar,
    citation: t.citation,
    redirect_route: t.redirect_route,
  }));
}
