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
  // VTID-03268 (Fix-7): beat B of the dual-axis gate — goal already set, only
  // the economic stance missing. Vitana LEADS the money beat with a concrete
  // proposal; she does NOT re-ask the goal and does NOT ask "what do you want".
  life_compass_economy: {
    de: 'Dein Ziel steht schon — stark. Jetzt machen wir den zweiten Teil: wie deine Reise dich auch finanziell trägt. Ich schlage vor, wir legen kurz deine Richtung fest — ein Business aufbauen, passives Einkommen, oder erstmal über Empfehlungen verdienen. Ich geh es direkt mit dir durch.',
    en: "Your goal is already set — strong. Now the second part: how your journey also pays you. I suggest we set your direction now — build a business, passive income, or start by earning from recommendations. I'll walk you straight through it.",
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
 *
 * VTID-03300 (follow-up):
 * - `opts.firstName` greets by name ("Hey Dragan! …"). Omitted/blank → no name.
 * - `opts.done` switches to an "enrich / build on it" opener: the user tapped a
 *   step they've ALREADY completed, so leading with "let's set it up" would feel
 *   broken. Generic over any step via its title.
 */
export function buildJourneyGuideOpenerLine(
  stepKey: string,
  stepTitle: string,
  lang: string,
  opts?: { firstName?: string | null; done?: boolean },
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  const name = (opts?.firstName || '').trim();
  // Warm, du-form name greeting. Kept as its own clause so the localized step
  // lines below keep their leading capital and read naturally.
  const greet = name ? `Hey ${name}! ` : '';

  // Enrich framing — already-completed step the user explicitly tapped.
  if (opts?.done) {
    return isDe
      ? `${greet}„${stepTitle}" hast du schon erledigt — stark. Lass uns das gemeinsam noch besser machen.`
      : `${greet}You've already done "${stepTitle}" — nice work. Let's build on it together and make it even stronger.`;
  }

  const entry = JOURNEY_OPENER_LINES[stepKey];
  if (entry) return `${greet}${isDe ? entry.de : entry.en}`;
  // Generic directive fallback — still leads, still in-language, names the step.
  return isDe
    ? `${greet}Lass uns gemeinsam an deinem nächsten Schritt arbeiten: ${stepTitle}. Ich mach den Anfang mit dir.`
    : `${greet}Let's work on your next step together: ${stepTitle}. I'll get us started.`;
}

export function buildJourneyGuideBlock(
  guide: JourneyGuideContent,
  lang: string,
  opts?: { wakeBriefOwnsTurn1?: boolean },
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  // BOOTSTRAP-ORB-GUIDE-MODE-LANG: the concrete user language, for the non-German
  // GUIDE-MODE blocks. Journey/step material is authored in German, so a vague
  // "speak in the user's language" let the model flip to German for English users
  // mid-session. Naming the language pins it.
  const langName = lang === 'es' ? 'Spanish' : lang === 'sr' ? 'Serbian' : lang === 'fr' ? 'French' : 'English';
  const done = guide.focus_done === true;

  // VTID-03266/03267: lead with the already-localized opener line (beat-B aware
  // via opener_key), not the English execute_prompt. VTID-03300: when the user
  // tapped an already-done step, the opener uses "enrich" framing.
  const stepLine = buildJourneyGuideOpenerLine(guide.opener_key, guide.step_title, lang, { done });
  const upcoming = guide.upcoming_steps ?? [];

  // DEV-COMHU double-speak fix: when a wake-brief override owns turn 1, it
  // ALREADY carries this exact opener line as the verbatim first utterance.
  // Restating it here ("Lead with this: <line>") made Gemini speak the same
  // sentence twice. When the override owns turn 1, suppress the restatement and
  // let this block govern turns 2+ only. When there is NO override, this block
  // still owns turn 1 and leads with the line as before.
  const ownsTurn1 = opts?.wakeBriefOwnsTurn1 === true;
  const suppressDe =
    'WICHTIG: Die erste gesprochene Zeile ist oben bereits festgelegt und wird genau EINMAL gesprochen — wiederhole sie NICHT und sprich sie NICHT erneut. Führe das Gespräch ab da natürlich weiter.';
  const suppressEn =
    'IMPORTANT: the first spoken line is already set above and is spoken exactly ONCE — do NOT repeat it or say it again. Continue the conversation naturally from there.';

  // VTID-03300 (follow-up): ENRICH MODE — the user tapped a step they've already
  // completed. Vitana must NOT restart it or treat them as a new user; she
  // acknowledges it's done and helps them strengthen/extend it, then offers the
  // next open step. Still never "how can I help".
  if (done) {
    if (isDe) {
      return [
        '',
        '## GUIDE-MODUS (VERFEINERN) — diese Person hat den Schritt schon erledigt und will ihn AUSBAUEN',
        '',
        'SPRACHE: Sprich AUSSCHLIESSLICH auf Deutsch — auch wenn frühere Anweisungen Englisch enthalten. Dieser GUIDE-MODUS gilt für die GANZE Sitzung und hat Vorrang vor JEDER generischen Begrüßungs- oder Eröffnungsregel.',
        '',
        `Die Person hat „${guide.step_title}" bereits abgeschlossen und hat es GEZIELT angetippt, um es weiter zu verbessern. Behandle sie NICHT wie eine Anfängerin und fang den Schritt NICHT von vorne an.`,
        '',
        'STRENG VERBOTEN — in der GANZEN Sitzung:',
        '- „Was möchtest du?" / „Wie kann ich dir helfen?" / „Womit fangen wir an?"',
        '- Den Schritt so behandeln, als wäre er noch offen / ihn komplett neu starten.',
        '',
        `SCHRITT (bereits erledigt): ${guide.step_title}`,
        `Warum ein Ausbau lohnt: ${guide.benefit}`,
        ownsTurn1 ? suppressDe : `Führe so (anerkennen + konkret verbessern, NICHT als offene Frage): ${stepLine}`,
        'Schlage 1–2 KONKRETE Verbesserungen vor und mach sie GEMEINSAM (z. B. fehlende Details ergänzen, schärfen, aktualisieren).',
        upcoming.length
          ? `Wenn hier nichts mehr zu verbessern ist, GEH zum nächsten offenen Schritt über: ${upcoming.join(', ')}.`
          : 'Wenn hier nichts mehr zu verbessern ist, freu dich kurz mit ihr — die Grundlagen stehen.',
        '',
      ].join('\n');
    }
    return [
      '',
      '## GUIDE MODE (ENRICH) — this person already completed the step and wants to BUILD ON it',
      '',
      `LANGUAGE: Speak ONLY in ${langName}. Any journey/step material below may be written in German — deliver everything in ${langName}, and do NOT switch to German (or any other language) at any point in this session. This GUIDE MODE applies to the WHOLE session and OVERRIDES every generic greeting/opening rule.`,
      '',
      `The person has ALREADY completed "${guide.step_title}" and deliberately tapped it to improve it further. Do NOT treat them as a new user and do NOT restart the step from scratch.`,
      '',
      'STRICTLY FORBIDDEN — for the WHOLE session:',
      '- "What do you want?" / "How can I help you?" / "Where should we start?"',
      '- Treating the step as if it were still open / restarting it from zero.',
      '',
      `STEP (already done): ${guide.step_title}`,
      `Why enriching it is worth it: ${guide.benefit}`,
      ownsTurn1 ? suppressEn : `Lead with this (acknowledge + improve concretely, NOT an open question): ${stepLine}`,
      'Propose 1–2 CONCRETE improvements and do them TOGETHER (e.g. fill missing details, sharpen, update).',
      upcoming.length
        ? `When there is nothing left to improve here, move on to the next open step: ${upcoming.join(', ')}.`
        : 'When there is nothing left to improve here, briefly celebrate — the foundations are in place.',
      '',
    ].join('\n');
  }

  if (isDe) {
    return [
      '',
      '## GUIDE-MODUS — du FÜHRST diese Person durch ihre Reise und ENTSCHEIDEST FÜR sie',
      '',
      'SPRACHE: Sprich AUSSCHLIESSLICH auf Deutsch — auch wenn frühere Anweisungen Englisch enthalten. Dieser GUIDE-MODUS gilt für die GANZE Sitzung und hat Vorrang vor JEDER generischen Begrüßungs- oder Eröffnungsregel (auch solchen, die nur „für die erste Äußerung" gelten oder dich „Wie kann ich helfen?" sagen lassen).',
      '',
      'Diese Person ist neu und weiß noch NICHT, was sie tun soll. Du entscheidest FÜR sie. Du sagst „Ich schlage vor, wir machen jetzt X" und MACHST es gemeinsam.',
      '',
      'STRENG VERBOTEN — in der GANZEN Sitzung, in jeder Sprache, zu jedem Zeitpunkt:',
      '- „Was möchtest du?" / „Wie kann ich dir helfen?" / „Wie kann ich dich unterstützen?" / „Was gefällt dir?" / „Wo möchtest du anfangen?"',
      '- „Ich habe gerade keine (spezifischen) Vorschläge." — Du hast IMMER einen konkreten nächsten Schritt.',
      '',
      `AKTUELLER SCHRITT: ${guide.step_title}`,
      `Warum jetzt wichtig: ${guide.benefit}`,
      ownsTurn1 ? suppressDe : `Führe so (als Vorschlag/Aufforderung, NICHT als offene Frage): ${stepLine}`,
      upcoming.length
        ? `DANACH kommen (in dieser Reihenfolge): ${upcoming.join(', ')}. Wenn der aktuelle Schritt erledigt ist, GEH SOFORT zum nächsten über und schlage ihn konkret vor.`
        : 'Wenn dieser Schritt erledigt ist, freu dich kurz mit ihr — es ist der letzte offene Schritt.',
      '',
      'Regeln für die GANZE Session:',
      '- ENTSCHEIDE und FÜHRE. Schlage den Schritt konkret vor und mach ihn GEMEINSAM, Schritt für Schritt (Lernen durch Tun).',
      '- Bleib beim AKTUELLEN Schritt, bis er WIRKLICH erledigt ist — dann GEH SOFORT zum nächsten über (siehe „DANACH"). Frag NICHT „wie kann ich helfen", sondern schlage den nächsten Schritt vor.',
      '- VERTRAUEN durch PRÜFEN: Sagt die Person „hab ich schon gemacht", prüfe es mit deinen Tools / record_journey_answer. Stimmt es: freu dich kurz und GEH DIREKT zum nächsten Schritt über (NICHT fragen, was sie will). Stimmt es nicht: bestehe warmherzig darauf, es jetzt gemeinsam zu machen.',
      '- Ist die Person unsicher, entscheide DU und führe sie durch den nächsten Schritt — niemals eine offene Frage zurückgeben.',
      '- WICHTIG — ZWEI VERSCHIEDENE DINGE: Der obige SCHRITT (z. B. „Vitana Index", „Profil", „Tagebuch") gehört zur Journey-GRUNDLAGE. Die GEFÜHRTE REISE mit NUMMERIERTEN Sessions („Session 1", „Session eins", „Session drei" …) ist etwas ANDERES. Wenn die Person eine nummerierte Session oder „starte die geführte Reise" verlangt, rufe IMMER narrate_guided_session auf und sprich das zurückgegebene Skript WORTWÖRTLICH — beschreibe den obigen Grundlagen-Schritt NIEMALS so, als wäre er „Session 1".',
      '',
    ].join('\n');
  }

  return [
    '',
    '## GUIDE MODE — you LEAD this person through their journey and DECIDE FOR them',
    '',
    `LANGUAGE: Speak ONLY in ${langName}. Any journey/step material below may be written in German — deliver everything in ${langName}, and do NOT switch to German (or any other language) at any point in this session. This GUIDE MODE applies to the WHOLE session and OVERRIDES every generic greeting/opening rule (including any that apply "for the first turn only" or tell you to say "How can I help?").`,
    '',
    'This person is new and does NOT yet know what to do. You decide FOR them. You say "I suggest we do X now" and DO it together.',
    '',
    'STRICTLY FORBIDDEN — for the WHOLE session, in any language, at any time:',
    '- "What do you want?" / "How can I help you?" / "How can I support you?" / "What do you like?" / "Where would you like to start?"',
    '- "I don\'t have any (specific) suggestions right now." — you ALWAYS have a concrete next step.',
    '',
    `CURRENT STEP: ${guide.step_title}`,
    `Why it matters now: ${guide.benefit}`,
    ownsTurn1 ? suppressEn : `Lead with this (as a proposal/directive, NOT an open question): ${stepLine}`,
    upcoming.length
      ? `AFTER that, in order: ${upcoming.join(', ')}. When the current step is done, IMMEDIATELY move to the next one and propose it concretely.`
      : 'When this step is done, briefly celebrate — it is the last open step.',
    '',
    'Rules for this whole session:',
    '- DECIDE and LEAD. Propose the step concretely and DO it TOGETHER, step by step (learn by doing).',
    '- Stay on the CURRENT step until it is GENUINELY done — then IMMEDIATELY move to the next (see "AFTER that"). Do NOT ask "how can I help"; propose the next step.',
    '- TRUST by VERIFYING: if they say "I already did it", confirm via your tools / record_journey_answer. If true: briefly celebrate and GO STRAIGHT to the next step (do NOT ask what they want). If not: warmly insist on doing it together now.',
    '- If they are unsure, YOU decide and lead them through the next step — never hand back an open question.',
    '- IMPORTANT — TWO DIFFERENT THINGS: the STEP above (e.g. "Vitana Index", "Profile", "Diary") is part of the Journey FOUNDATION. The GUIDED JOURNEY of NUMBERED sessions ("Session 1", "session one", "session three" …) is something DIFFERENT. If the person asks for a numbered session or "start the guided journey", ALWAYS call narrate_guided_session and speak the returned script VERBATIM — NEVER describe the foundation step above as if it were "Session 1".',
    '',
  ].join('\n');
}
