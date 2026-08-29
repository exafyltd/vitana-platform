/**
 * VTID-03290 — GUIDE MODE (TEACH) system-instruction block for Guided Topic
 * Narration.
 *
 * When a user taps a session/topic in the Guided Journey catalog, this block
 * turns Vitana into a proactive teacher for THAT topic: she introduces it,
 * teaches it conversationally FROM the authored KB material (paraphrase — never
 * a verbatim script read), then guides the user to the topic's practice target.
 * Bundled onto the guided-topic-narration candidate and injected for the whole
 * session (turns 2+), the way Teacher Mode / Journey Guide are.
 */

import type { GuidedTopicNarrationContent } from '../../../services/assistant-continuation/providers/guided-topic-narration';
import { LOCALE_ENGLISH_NAME, resolveLocaleStrict } from '../../../i18n/catalog';

/**
 * The SPOKEN opener LINE. CRITICAL transport constraint (same as the journey
 * guide): on LiveKit the Python agent plays this via `session.say()` LITERALLY —
 * no LLM translation — and on Vertex it is wrapped "speak verbatim". So it MUST
 * already be in the session language. It is a short, warm lead-in that NAMES the
 * topic; the actual teaching lives in the TEACH block below (turns 2+).
 *
 * de + en today (the platform's active languages; the user base is German).
 * Other langs fall back to en — a pre-existing session.say() limitation across
 * every provider, not specific to this one. The topic title is taken from the
 * published catalog (German for the German curriculum), so a German session gets
 * a fully German opener.
 */
export function buildGuidedTopicNarrationOpenerLine(
  topicTitle: string,
  lang: string,
  opts?: { firstName?: string | null },
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  const name = (opts?.firstName || '').trim();
  const greet = name ? `Hey ${name}! ` : '';
  return isDe
    ? `${greet}Lass uns über ${topicTitle} sprechen — ich erklär dir, worum es geht und wie es dir hilft.`
    : `${greet}Let's talk about ${topicTitle} — I'll walk you through what it is and how it helps you.`;
}

/**
 * VTID-03293 — the SPOKEN LESSON: the actual teaching Vitana speaks on turn 1.
 *
 * WHY this is the spoken line (not a short opener + "teach more" instruction):
 * Gemini Live native-audio reliably produces AUDIO only for a SHORT, DIRECT
 * user turn ("say exactly: <line>"). A long INSTRUCTIONAL trigger ("then teach
 * across several sentences per the block…") makes it answer text-only or delay
 * first audio past the AudioContext suspend window → no speech, UI stuck
 * "connecting" (the VTID-03102 regression we hit on staging). So we put the
 * teaching INTO the spoken line itself: the authored `voice_script` IS the
 * lesson (the author wrote it as what Vitana says), and the greeting path speaks
 * it verbatim — reliable audio + real teaching. Falls back to a short lesson
 * built from the explanation fields when no script is authored.
 */
export function buildGuidedTopicSpokenLesson(
  content: GuidedTopicNarrationContent,
  lang: string,
  opts?: { firstName?: string | null },
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  const name = (opts?.firstName || '').trim();
  const greet = name ? `Hey ${name}! ` : '';

  let body = (content.voice_script || '').trim();
  if (!body) {
    const exp = content.explanation || { whatItIs: null, userBenefit: null, whenToUse: null, tryThis: null };
    const parts: string[] = [];
    parts.push(isDe ? `Lass uns über ${content.topic_title} sprechen.` : `Let's talk about ${content.topic_title}.`);
    if (exp.whatItIs) parts.push(exp.whatItIs);
    if (exp.userBenefit) parts.push(exp.userBenefit);
    if (exp.tryThis) parts.push(exp.tryThis);
    body = parts.join(' ').trim();
  }
  return `${greet}${body}`.trim();
}

/**
 * VTID-03650 — the SHORT turn-1 line when the lesson was ALREADY delivered as
 * pre-recorded Polly audio (see `guided-topic-narration-audio.ts`). Replaces
 * `buildGuidedTopicSpokenLesson` for this case: the model no longer needs to
 * (and — per VTID-03647/03648 — reliably cannot be trusted to) say the lesson
 * itself, so its first turn is a short, safe, natural follow-up instead of the
 * lesson text. Same literal-line constraint as the other spoken lines in this
 * file (native-audio needs a short, direct turn to reliably produce audio —
 * VTID-03293) and the same de/en-only scope as `buildGuidedTopicNarrationOpenerLine`.
 */
export function buildGuidedTopicPostNarrationLine(
  topicTitle: string,
  lang: string,
  opts?: { hasPracticeTarget?: boolean },
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  if (isDe) {
    return opts?.hasPracticeTarget
      ? `So, das war ${topicTitle}. Hast du Fragen dazu, oder sollen wir direkt gemeinsam loslegen?`
      : `So, das war ${topicTitle}. Hast du Fragen dazu?`;
  }
  return opts?.hasPracticeTarget
    ? `So, that was ${topicTitle}. Any questions about it, or should we jump straight into practicing it together?`
    : `So, that was ${topicTitle}. Any questions about it?`;
}

/**
 * The GUIDE-MODE TEACH block. Governs turns 2+ (follow-up Q&A about the topic).
 *
 * VTID-03650: when `content.narrationAudio` is set, the lesson was already
 * delivered verbatim as pre-recorded Polly audio BEFORE this session's live
 * model turn ever ran — the raw curriculum text (`voice_script`) must NOT be
 * re-injected here, because that is exactly the payload VTID-03647/03648
 * measured Nova and Vertex both independently rejecting. This branch carries
 * only topic_title/practice_target (safe, short, non-curriculum) so the model
 * can field follow-up questions and guide to practice without ever seeing the
 * raw material again.
 */
export function buildGuidedTopicNarrationBlock(
  content: GuidedTopicNarrationContent,
  lang: string,
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');

  if (content.narrationAudio) {
    return isDe
      ? [
          '',
          '## GUIDE-MODUS (NACH DER LEKTION) — die Lektion wurde bereits per Audio vorgetragen',
          '',
          'SPRACHE: Sprich AUSSCHLIESSLICH auf Deutsch, für die GANZE Sitzung.',
          '',
          `Die Lektion zu ${content.topic_title} wurde der Person GERADE als vorab aufgenommene Audio-Lektion vorgespielt und muss nicht wiederholt werden.`,
          '',
          'Wichtig, für die GANZE Sitzung:',
          '- Trage die Lektion nicht erneut vor und fasse sie nicht zusammen — geh direkt zu Rückfragen oder dem nächsten Schritt über.',
          '- Überspring generische Eröffnungsfragen — du weißt, worum es gerade ging.',
          '- Wenn die Person kurz mit Ja, Mach das oder Okay antwortet, prüfe zuerst, ob sie noch Rückfragen hat, bevor du zu einer anderen Aktion übergehst.',
          '',
          'So führst du:',
          '- Beantworte Rückfragen zur Lektion natürlich und knapp.',
          content.practice_target
            ? `- Wenn die Person bereit ist, FÜHRE sie zur Übung (${content.practice_target}) — biete an, es direkt gemeinsam zu machen.`
            : '- Wenn die Person bereit ist, schlage einen konkreten nächsten Schritt vor.',
          '- Sobald du das getan hast und die Person keine weiteren Rückfragen mehr hat, rufe das Tool end_guided_topic_teaching auf, um die Sitzung abzuschließen — sprich NICHT einfach in allgemeiner Unterhaltung weiter.',
          '',
        ].join('\n')
      : [
          '',
          '## GUIDE MODE (POST-LESSON) — the lesson was already narrated via audio',
          '',
          `LANGUAGE: Speak ONLY in ${LOCALE_ENGLISH_NAME[resolveLocaleStrict(lang) ?? 'en'] || 'English'}, for the WHOLE session.`,
          '',
          `The lesson on ${content.topic_title} was just delivered to the person as a pre-recorded audio narration and does not need to be repeated.`,
          '',
          'Important, for the WHOLE session:',
          '- Don\'t re-narrate or summarize the lesson — move straight to follow-up questions or the next step.',
          '- Skip generic opening questions — you already KNOW what this was just about.',
          '- If they respond with a brief yes, sure, or okay, check first whether they have follow-up questions before moving on to anything else.',
          '',
          'How to lead:',
          '- Answer follow-up questions about the lesson naturally and concisely.',
          content.practice_target
            ? `- Once they're ready, GUIDE them to the practice (${content.practice_target}) — offer to do it together right now.`
            : '- Once they\'re ready, propose a concrete next step.',
          '- Once you\'ve done that and they have no more follow-up questions, call the end_guided_topic_teaching tool to close things out — do NOT just keep talking in general conversation.',
          '',
        ].join('\n');
  }

  const exp = content.explanation || {
    whatItIs: null,
    userBenefit: null,
    whenToUse: null,
    tryThis: null,
  };

  // The KB material the model teaches FROM (paraphrased). Only include the parts
  // that are authored, so an empty field never injects a dangling label.
  const material: string[] = [];
  if (content.voice_script) material.push(`${isDe ? 'Skript' : 'Script'}: ${content.voice_script}`);
  if (exp.whatItIs) material.push(`${isDe ? 'Was es ist' : 'What it is'}: ${exp.whatItIs}`);
  if (exp.userBenefit) material.push(`${isDe ? 'Dein Nutzen' : 'User benefit'}: ${exp.userBenefit}`);
  if (exp.whenToUse) material.push(`${isDe ? 'Wann es hilft' : 'When to use'}: ${exp.whenToUse}`);
  if (exp.tryThis) material.push(`${isDe ? 'Probier das' : 'Try this'}: ${exp.tryThis}`);
  const materialBlock = material.length
    ? material.map((m) => `- ${m}`).join('\n')
    : isDe
      ? '- (Noch kein Skript hinterlegt — erkläre das Thema knapp aus allgemeinem Wissen und führe dann zur Übung.)'
      : '- (No script authored yet — explain the topic briefly from general knowledge, then lead to the practice.)';

  if (isDe) {
    return [
      '',
      '## GUIDE-MODUS (LEHREN) — du STELLST dieses Thema VOR und LEHRST es',
      '',
      'SPRACHE: Sprich AUSSCHLIESSLICH auf Deutsch — auch wenn frühere Anweisungen Englisch enthalten. Dieser GUIDE-MODUS gilt für die GANZE Sitzung.',
      '',
      `Die Person hat in Meine Reise das Thema ${content.topic_title} angetippt, um es von dir erklärt zu bekommen. Stell es vor und LEHRE es — proaktiv, in EIGENEN Worten.`,
      '',
      'Wichtig — für die GANZE Sitzung:',
      '- Überspring generische Eröffnungsfragen — du weißt, worum es geht: dieses Thema.',
      '- Das Skript nicht vorlesen, Wort für Wort. Nutze es als Grundlage und erkläre es natürlich, im Gespräch.',
      '- Ein kurzes Ja, Mach das oder Okay der Person direkt nach deiner Eröffnungszeile bedeutet erklär mir das jetzt — nicht spring zum nächsten Schritt. Erkläre zuerst die Kernpunkte aus dem Lehrmaterial unten, in eigenen Worten, bevor du zur Übung überleitest oder etwas anderes vorschlägst.',
      '',
      `THEMA: ${content.topic_title}`,
      'Lehrmaterial (paraphrasieren, NICHT vorlesen):',
      materialBlock,
      '',
      'So führst du:',
      '- Stell das Thema in 1–2 Sätzen vor, dann erkläre es klar und konkret in eigenen Worten.',
      '- Halte es im Gespräch: kurze Abschnitte, prüfe das Verständnis, geh auf Rückfragen ein.',
      content.practice_target
        ? `- Wenn die Person es verstanden hat, FÜHRE sie zur Übung (${content.practice_target}) — biete an, es direkt gemeinsam zu machen.`
        : '- Wenn die Person es verstanden hat, schlage einen konkreten nächsten Schritt vor.',
      '- Sobald du das getan hast und die Person keine weiteren Rückfragen mehr hat, rufe das Tool end_guided_topic_teaching auf, um die Sitzung abzuschließen — sprich NICHT einfach in allgemeiner Unterhaltung weiter.',
      '',
    ].join('\n');
  }

  // BOOTSTRAP-ORB-GUIDE-MODE-LANG: name the user's language CONCRETELY. The
  // teaching material below is authored in German (the KB), and the previous
  // vague "speak in the user's language" let the German source pull the model
  // into German for English (and other non-German) users mid-session.
  //
  // VTID-03644: this used to be a local 4-way ternary (es/sr/fr/else-English)
  // — a 4th undocumented copy of exactly the "language name lives in three
  // places, a new locale updates some and not others" bug VTID-03509 already
  // fixed once for the notification catalog (see catalog.ts's own comment on
  // LOCALE_ENGLISH_NAME). Every locale not in that ternary — pt, ru, pl (all
  // already GA/beta) and every one of the 9-language rollout's new locales —
  // was silently told "Speak ONLY in English" here. Reuse the shared registry
  // instead of re-declaring it a 4th time.
  // resolveLocaleStrict (not normalizeLocale) so an empty/unrecognized `lang`
  // keeps the previous fallback to English rather than silently becoming German.
  const langName = LOCALE_ENGLISH_NAME[resolveLocaleStrict(lang) ?? 'en'] || 'English';
  return [
    '',
    '## GUIDE MODE (TEACH) — you INTRODUCE this topic and TEACH it',
    '',
    `LANGUAGE: Speak ONLY in ${langName}. The teaching material below may be written in German — translate and deliver everything in ${langName}, and do NOT switch to German (or any other language) at any point in this session. This GUIDE MODE applies to the WHOLE session.`,
    '',
    `The person tapped the topic ${content.topic_title} in My Journey to have you explain it. Introduce it and TEACH it — proactively, in your OWN words.`,
    '',
    'Important — for the WHOLE session:',
    '- Skip generic opening questions — you know what this is about: this topic.',
    '- Don\'t read the script word-for-word. Use it as the basis and explain it naturally, conversationally.',
    '- A brief yes, sure, or okay from the person right after your opening line means explain it to me now — not skip to the next step. Explain the core points from the teaching material below, in your own words, before moving on to practice or anything else.',
    '',
    `TOPIC: ${content.topic_title}`,
    'Teaching material (paraphrase, do NOT read aloud):',
    materialBlock,
    '',
    'How to lead:',
    '- Introduce the topic in 1–2 sentences, then explain it clearly and concretely in your own words.',
    '- Keep it conversational: short chunks, check understanding, answer follow-ups.',
    content.practice_target
      ? `- Once they get it, GUIDE them to the practice (${content.practice_target}) — offer to do it together right now.`
      : '- Once they get it, propose a concrete next step.',
    '- Once you\'ve done that and they have no more follow-up questions, call the end_guided_topic_teaching tool to close things out — do NOT just keep talking in general conversation.',
    '',
  ].join('\n');
}
