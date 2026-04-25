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
    summary_voice_en: "Honestly, this is one of the easiest things in the whole app. You tap the microphone in Daily Diary and just say 'I drank a glass of water' — and you're done. No typing, no measuring cups, no forms. Two seconds, and your Hydration pillar moves. Most people do it while they're pouring the next glass.",
    summary_voice_de: "Ganz ehrlich — das ist eines der einfachsten Dinge in der ganzen App. Du tippst auf das Mikrofon im Daily Diary und sagst einfach 'Ich habe ein Glas Wasser getrunken' — fertig. Kein Tippen, kein Abmessen, keine Formulare. Zwei Sekunden, und deine Hydration-Säule bewegt sich. Die meisten machen das beim Einschenken vom nächsten Glas.",
    steps_voice_en: [
      "Open Daily Diary, tap the microphone.",
      "Say it naturally — 'I just drank a big glass of water'.",
      "Tap done. Your Hydration pillar updates in the next minute.",
    ],
    steps_voice_de: [
      "Daily Diary öffnen, Mikrofon antippen.",
      "Natürlich sprechen — 'Ich habe gerade ein großes Glas Wasser getrunken'.",
      "Auf Fertig tippen. Deine Hydration-Säule aktualisiert sich in der nächsten Minute.",
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
    summary_voice_en: "Logging a meal is faster than typing this sentence. Tap the mic in Daily Diary, describe what you ate the way you'd tell a friend — 'oatmeal with berries and coffee' — and that's it. No calorie counting, no menus to scroll, no photos required. Your Nutrition pillar starts moving the same day.",
    summary_voice_de: "Eine Mahlzeit zu protokollieren geht schneller als diesen Satz zu lesen. Mikrofon im Daily Diary antippen, beschreiben was du gegessen hast — so wie du es einem Freund erzählen würdest, 'Haferflocken mit Beeren und Kaffee' — fertig. Keine Kalorienzählerei, keine endlosen Menüs, keine Fotos nötig. Deine Nutrition-Säule bewegt sich noch am selben Tag.",
    steps_voice_en: [
      "Open Daily Diary, tap the microphone.",
      "Describe the meal in one sentence — breakfast, lunch, snack, doesn't matter.",
      "Tap done. The system handles the rest.",
    ],
    steps_voice_de: [
      "Daily Diary öffnen, Mikrofon antippen.",
      "Die Mahlzeit in einem Satz beschreiben — egal ob Frühstück, Mittagessen oder Snack.",
      "Auf Fertig tippen. Den Rest übernimmt das System.",
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
    summary_voice_en: "Logging a workout is super easy — one sentence into Daily Diary, right after you finish. 'Walked 30 minutes' or 'gym session, mostly upper body' is enough. No timer to start, no app to launch, no fields to fill. Your Exercise pillar feels it the same day. Connecting a tracker like Apple Health later gives even richer data, but you don't need it to start.",
    summary_voice_de: "Ein Workout zu protokollieren ist wirklich nur ein Satz im Daily Diary, gleich nachdem du fertig bist. '30 Minuten gelaufen' oder 'Studio, hauptsächlich Oberkörper' reicht völlig. Keine App starten, keinen Timer drücken, nichts ausfüllen. Deine Exercise-Säule spürt es noch am selben Tag. Einen Tracker wie Apple Health später anzuschließen liefert noch mehr Details, aber zum Anfangen brauchst du das nicht.",
    steps_voice_en: [
      "Open Daily Diary, tap the microphone.",
      "One sentence — what you did, roughly how long.",
      "Tap done. Goes straight to your Exercise pillar.",
    ],
    steps_voice_de: [
      "Daily Diary öffnen, Mikrofon antippen.",
      "Ein Satz — was du gemacht hast, ungefähr wie lange.",
      "Auf Fertig tippen. Geht direkt in deine Exercise-Säule.",
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
    summary_voice_en: "Logging sleep takes about ten seconds in the morning — open Daily Diary, tap the mic, say 'slept from eleven to six-thirty, woke up rested'. That's the whole thing. Most people do it before the first coffee. A sleep tracker like Oura adds depth later, but a one-line voice note is enough to get your Sleep pillar moving.",
    summary_voice_de: "Schlaf zu protokollieren dauert morgens ungefähr zehn Sekunden — Daily Diary öffnen, Mikrofon antippen, 'von elf bis halb sieben geschlafen, ausgeruht aufgewacht'. Das war's. Die meisten machen das vor dem ersten Kaffee. Ein Tracker wie Oura liefert später mehr Tiefe, aber ein kurzer Sprachhinweis reicht, um deine Sleep-Säule in Bewegung zu bringen.",
    steps_voice_en: [
      "Morning routine — open Daily Diary, tap the microphone.",
      "One sentence: when you slept, how rested you feel.",
      "Tap done. Sleep pillar updates.",
    ],
    steps_voice_de: [
      "Morgenroutine — Daily Diary öffnen, Mikrofon antippen.",
      "Ein Satz: Wann du geschlafen hast, wie ausgeruht du dich fühlst.",
      "Auf Fertig tippen. Sleep-Säule aktualisiert sich.",
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
    summary_voice_en: "Mental is the easiest pillar to feed — you literally just say what's on your mind. Tap the mic in Daily Diary, talk for ten or fifteen seconds the way you'd talk to a friend, and that's an entry. 'A bit stressed about the meeting, meditated for ten minutes' — done. No mood scales to tap, no checkboxes. The honesty is what counts.",
    summary_voice_de: "Mental ist die einfachste Säule zu füttern — du sagst einfach, was dir durch den Kopf geht. Mikrofon im Daily Diary antippen, zehn oder fünfzehn Sekunden so reden, wie du mit einem Freund sprichst — schon ist es ein Eintrag. 'Etwas gestresst wegen des Meetings, zehn Minuten meditiert' — fertig. Keine Stimmungsskalen, keine Häkchen. Auf die Ehrlichkeit kommt es an.",
    steps_voice_en: [
      "Open Daily Diary, tap the microphone.",
      "Talk freely for a few seconds — what's on your mind, what helped today.",
      "Tap done. Your Mental pillar reflects it.",
    ],
    steps_voice_de: [
      "Daily Diary öffnen, Mikrofon antippen.",
      "Frei reden für ein paar Sekunden — was dich beschäftigt, was heute geholfen hat.",
      "Auf Fertig tippen. Deine Mental-Säule zieht das mit ein.",
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
    summary_voice_en: "Daily Diary is honestly the most enjoyable part of the system to use. You tap the microphone, you talk for a few seconds about your day — what you ate, how you slept, how the workout went, what's on your mind — and the system turns it all into entries that feed four of your five Vitana pillars. No typing on a phone keyboard, no menus, no checkboxes. It's faster than writing it down and more accurate than trying to remember at the end of the day. People who use it daily say it becomes the favourite ritual of their morning or evening.",
    summary_voice_de: "Daily Diary ist ehrlich gesagt der angenehmste Teil des Systems. Du tippst auf das Mikrofon, sprichst ein paar Sekunden über deinen Tag — was du gegessen hast, wie du geschlafen hast, wie das Workout lief, was dich beschäftigt — und das System macht daraus Einträge, die vier deiner fünf Vitana-Säulen versorgen. Kein Tippen auf der Handytastatur, keine Menüs, keine Häkchen. Schneller als Aufschreiben, genauer als das Erinnern am Abend. Wer es täglich nutzt, sagt, es wird zum liebsten Ritual des Morgens oder Abends.",
    steps_voice_en: [
      "Open Daily Diary from the bottom navigation, tap the microphone.",
      "Talk naturally — one entry can cover several things ('slept seven hours, had eggs for breakfast, walking to work now').",
      "Tap done. The system splits it across the right pillars automatically.",
      "Dictate two or three times a day — morning, midday, evening — and your Index has rich signal to work with.",
    ],
    steps_voice_de: [
      "Daily Diary in der unteren Navigation öffnen, Mikrofon antippen.",
      "Natürlich reden — ein Eintrag kann mehrere Dinge abdecken ('sieben Stunden geschlafen, Eier zum Frühstück, gehe gerade zur Arbeit').",
      "Auf Fertig tippen. Das System verteilt es automatisch auf die richtigen Säulen.",
      "Zwei- oder dreimal am Tag diktieren — morgens, mittags, abends — und dein Index hat reichlich Signal zum Arbeiten.",
    ],
    redirect_route: '/daily-diary',
    redirect_offer_en: "Want me to open Daily Diary so you can try it right now?",
    redirect_offer_de: "Soll ich dir Daily Diary öffnen, damit du es gleich ausprobieren kannst?",
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
