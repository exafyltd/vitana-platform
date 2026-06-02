/**
 * VTID-03257 (Fix-1) — GUIDE MODE system-instruction block.
 *
 * Renders the behavioral contract that turns Vitana from a passive assistant
 * into a proactive, hand-holding journey guide for users still on the Journey
 * Foundation. Bundled onto the journey-guide candidate and injected for the
 * whole session (turns 2+), the way Teacher Mode is.
 */

import type { JourneyGuideContent } from '../../../services/assistant-continuation/providers/journey-guide';

/**
 * VTID-03266 (Fix-6) — the SPOKEN opener LINE for the journey guide.
 *
 * CRITICAL transport constraint: this string becomes the candidate's
 * `userFacingLine`, and on LiveKit the Python agent plays it via
 * `session.say(user_facing_line)` LITERALLY — there is NO LLM translation step
 * (orb-agent/session.py: "session.say() speaks the literal string we pass").
 * On Vertex it is wrapped by buildVertexWakeBriefBlock as "speak verbatim, do
 * NOT translate". So the line MUST already be in the session language — we
 * cannot rely on the model to translate it. That is why the previous approach
 * (English execute_prompt, or a structured instruction block) produced English
 * speech for German users / would have made LiveKit read instructions aloud.
 *
 * These are short, warm DIRECTIVES (lead + do-it-together), never an open
 * "what do you want / how can I help". The whole-session ban on passive
 * openers lives in buildJourneyGuideBlock (injected as system instruction on
 * BOTH transports), which governs turns 2+.
 *
 * de + en today (the platform's active languages; the user base is German).
 * Other langs fall back to en — a pre-existing limitation of session.say()
 * across every provider, not specific to the journey guide.
 */
const JOURNEY_OPENER_LINES: Record<string, { de: string; en: string }> = {
  life_compass: {
    de: 'Lass uns gemeinsam deinen Lebenskompass setzen — dein eine großes Ziel, an dem sich alles ausrichtet. Ich mach den Anfang mit dir, Schritt für Schritt.',
    en: "Let's set your Life Compass together — the one big goal everything aligns to. I'll get us started, step by step.",
  },
  weakest_habit: {
    de: 'Jetzt finden wir gemeinsam die eine Gewohnheit, die dich am meisten ausbremst — damit ich dir schnell zu ersten Erfolgen verhelfe. Ich fang mit dir an.',
    en: "Now let's pin down the one habit holding you back most, so I can get you quick wins. I'll start with you.",
  },
  reminder: {
    de: 'Lass uns deine erste Erinnerung gemeinsam einrichten — dein erster kleiner Gewinn. Ich zeig dir genau, wie.',
    en: "Let's set up your first reminder together — your first quick win. I'll show you exactly how.",
  },
  understand_economy: {
    de: 'Ich zeige dir jetzt, wie die Langlebigkeits-Ökonomie hier funktioniert — und wie sie für dich arbeitet. Lass uns kurz gemeinsam reinschauen.',
    en: "Let me show you how the longevity economy here works — and how it works for you. Let's take a quick look together.",
  },
  profile: {
    de: 'Lass uns dein Profil gemeinsam vervollständigen — das dauert nur einen Moment, und ich geh es mit dir durch.',
    en: "Let's complete your profile together — it only takes a moment, and I'll walk you through it.",
  },
  diary: {
    de: 'Lass uns deinen ersten Tagebucheintrag zusammen machen — ich zeig dir, wie einfach das ist.',
    en: "Let's make your first diary entry together — I'll show you how simple it is.",
  },
  vitana_index: {
    de: 'Lass uns deinen Vitana-Index gemeinsam aufsetzen — deine Startmessung. Ich führe dich durch.',
    en: "Let's set up your Vitana Index together — your baseline. I'll guide you through it.",
  },
  economic_aspiration: {
    de: 'Jetzt halten wir gemeinsam fest, wie deine Reise dich auch finanziell unterstützen soll. Ich mach den Anfang mit dir.',
    en: "Now let's capture how your journey should support you financially too. I'll get us started.",
  },
  calendar: {
    de: 'Lass uns deinen ersten Termin gemeinsam in den Kalender setzen — ich zeig dir, wie.',
    en: "Let's put your first event on the calendar together — I'll show you how.",
  },
  autopilot: {
    de: 'Ich zeige dir jetzt deinen Autopiloten — deinen autonomen Einkommens-Helfer. Lass uns kurz gemeinsam draufschauen.',
    en: "Let me show you your Autopilot — your autonomous income agent. Let's take a quick look together.",
  },
  connect: {
    de: 'Lass uns dich mit den ersten Menschen hier verbinden — ich mach den ersten Schritt mit dir.',
    en: "Let's connect you with your first people here — I'll take the first step with you.",
  },
  events: {
    de: 'Lass uns gemeinsam dein erstes Event hier finden — ich zeig dir, wo es losgeht.',
    en: "Let's find your first event here together — I'll show you where to start.",
  },
  marketplace: {
    de: 'Lass uns gemeinsam den Marktplatz erkunden — ich zeig dir, wie er für dich arbeitet.',
    en: "Let's explore the Marketplace together — I'll show you how it works for you.",
  },
  business_live_media: {
    de: 'Ich zeige dir jetzt, wie du hier mit Business, Live und Media etwas aufbauen kannst. Lass uns kurz gemeinsam reinschauen.',
    en: "Let me show you how you can build something here with Business, Live and Media. Let's take a quick look together.",
  },
};

/**
 * The clean, already-localized spoken opener line for a step. Falls back to a
 * generic lead-in (still a directive, still in-language) for any step key not
 * in the map, so a new step never silently produces an English/empty opener.
 */
export function buildJourneyGuideOpenerLine(stepKey: string, stepTitle: string, lang: string): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  const entry = JOURNEY_OPENER_LINES[stepKey];
  if (entry) return isDe ? entry.de : entry.en;
  // Generic directive fallback — still leads, still in-language, names the step.
  return isDe
    ? `Lass uns gemeinsam an deinem nächsten Schritt arbeiten: ${stepTitle}. Ich mach den Anfang mit dir.`
    : `Let's work on your next step together: ${stepTitle}. I'll get us started.`;
}

export function buildJourneyGuideBlock(guide: JourneyGuideContent, lang: string): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');

  // VTID-03266 (Fix-6): use the already-localized opener line as the lead, not
  // the English execute_prompt — otherwise the German block embeds English.
  const stepLine = buildJourneyGuideOpenerLine(guide.step_key, guide.step_title, lang);

  if (isDe) {
    return [
      '',
      '## GUIDE-MODUS — du FÜHRST diese Person durch ihre Reise, Schritt für Schritt',
      '',
      'SPRACHE: Sprich AUSSCHLIESSLICH auf Deutsch — auch wenn frühere Anweisungen Englisch enthalten. Dieser GUIDE-MODUS gilt für die GANZE Sitzung und hat Vorrang vor jeder generischen Begrüßungsregel (auch solchen, die nur „für die erste Äußerung" gelten oder dich „Wie kann ich helfen?" sagen lassen).',
      '',
      'Diese Person ist neu in VitanaLand und weiß noch NICHT, was sie tun soll. Du bist ihr proaktiver Guide. Du FÜHRST. Du fragst NIEMALS „Was möchtest du?" oder „Wie kann ich helfen?".',
      '',
      `AKTUELLER SCHRITT: ${guide.step_title}`,
      `Warum jetzt wichtig: ${guide.benefit}`,
      `Führe so: ${stepLine}`,
      '',
      'Regeln für diese ganze Session:',
      '- Formuliere den Schritt als klare AUFFORDERUNG und MACH ihn GEMEINSAM mit der Person — jetzt, Schritt für Schritt, damit sie durch Tun lernt (nicht durch Erklären).',
      '- NUR DIESEN EINEN Schritt. Spring nicht voraus.',
      '- Stelle NIEMALS offene „Was möchtest du / Wie kann ich helfen"-Fragen. Wenn die Person unsicher ist, führe sie durch den aktuellen Schritt.',
      '- VERTRAUEN durch PRÜFEN: Sagt die Person, sie habe es erledigt, glaube es NICHT einfach — bestätige es anhand der echten Daten (mit deinen Tools / record_journey_answer). Ist es NICHT erledigt, bestehe warmherzig darauf: „Das ist noch nicht erledigt — komm, lass es uns zusammen machen, ich zeige dir wie."',
      '- Wenn der Schritt WIRKLICH abgeschlossen ist, freu dich kurz mit ihr und sag, dass es nächstes Mal weitergeht.',
      '',
    ].join('\n');
  }

  return [
    '',
    '## GUIDE MODE — you LEAD this person through their journey, one step at a time',
    '',
    'LANGUAGE: speak ONLY in the user\'s language — even if earlier instructions contain English. This GUIDE MODE applies to the WHOLE session and OVERRIDES every generic greeting rule (including any that apply "for the first turn only" or tell you to say "How can I help?").',
    '',
    'This person is new to VitanaLand and does NOT yet know what to do. You are their proactive guide. You LEAD. You NEVER ask "What do you want?" or "How can I help?".',
    '',
    `CURRENT STEP: ${guide.step_title}`,
    `Why it matters now: ${guide.benefit}`,
    `Lead with this: ${stepLine}`,
    '',
    'Rules for this whole session:',
    '- State the step as a clear DIRECTIVE and DO it TOGETHER with the person — right now, step by step, so they learn by doing (not by explanation).',
    '- ONLY this one step. Do not jump ahead.',
    '- NEVER ask open-ended "what do you want / how can I help". If they are unsure, lead them through the current step.',
    '- TRUST by VERIFYING: if they say they already did it, do NOT just believe them — confirm against the real data (via your tools / record_journey_answer). If it is NOT done, warmly insist: "That\'s not done yet — come on, let\'s do it together, I\'ll show you how."',
    '- When the step is GENUINELY complete, briefly celebrate the win with them and say you\'ll continue next time.',
    '',
  ].join('\n');
}
