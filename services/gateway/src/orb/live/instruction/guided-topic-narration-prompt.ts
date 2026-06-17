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
    ? `${greet}Lass uns über „${topicTitle}" sprechen — ich erklär dir, worum es geht und wie es dir hilft.`
    : `${greet}Let's talk about "${topicTitle}" — I'll walk you through what it is and how it helps you.`;
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
    parts.push(isDe ? `Lass uns über „${content.topic_title}" sprechen.` : `Let's talk about "${content.topic_title}".`);
    if (exp.whatItIs) parts.push(exp.whatItIs);
    if (exp.userBenefit) parts.push(exp.userBenefit);
    if (exp.tryThis) parts.push(exp.tryThis);
    body = parts.join(' ').trim();
  }
  return `${greet}${body}`.trim();
}

/**
 * The GUIDE-MODE TEACH block. Governs turns 2+ (follow-up Q&A about the topic):
 * the lesson itself is spoken on turn 1 via the spoken line (see
 * buildGuidedTopicSpokenLesson); this block tells the model how to handle the
 * conversation AFTER the lesson. Bundled on the candidate, injected on both
 * transports — like the Journey Guide block.
 */
export function buildGuidedTopicNarrationBlock(
  content: GuidedTopicNarrationContent,
  lang: string,
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
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
      'SPRACHE: Sprich AUSSCHLIESSLICH auf Deutsch — auch wenn frühere Anweisungen Englisch enthalten. Dieser GUIDE-MODUS gilt für die GANZE Sitzung und hat Vorrang vor JEDER generischen Begrüßungs- oder Eröffnungsregel.',
      '',
      `Die Person hat in „Meine Reise" das Thema „${content.topic_title}" angetippt, um es von dir erklärt zu bekommen. Stell es vor und LEHRE es — proaktiv, in EIGENEN Worten.`,
      '',
      'STRENG VERBOTEN — in der GANZEN Sitzung:',
      '- „Was möchtest du?" / „Wie kann ich dir helfen?" / „Womit fangen wir an?" — du WEISST, worum es geht: dieses Thema.',
      '- Das Skript Wort für Wort vorlesen. Nutze es als GRUNDLAGE und erkläre es natürlich, im Gespräch.',
      '',
      `THEMA: ${content.topic_title}`,
      'Lehrmaterial (paraphrasieren, NICHT vorlesen):',
      materialBlock,
      '',
      'So führst du:',
      '- Stell das Thema in 1–2 Sätzen vor, dann erkläre es klar und konkret in eigenen Worten.',
      '- Halte es im Gespräch: kurze Abschnitte, prüfe das Verständnis, geh auf Rückfragen ein.',
      content.practice_target
        ? `- Wenn die Person es verstanden hat, FÜHRE sie zur Übung („${content.practice_target}") — biete an, es direkt gemeinsam zu machen.`
        : '- Wenn die Person es verstanden hat, schlage einen konkreten nächsten Schritt vor.',
      '',
    ].join('\n');
  }

  return [
    '',
    '## GUIDE MODE (TEACH) — you INTRODUCE this topic and TEACH it',
    '',
    'LANGUAGE: speak ONLY in the user\'s language — even if earlier instructions contain English. This GUIDE MODE applies to the WHOLE session and OVERRIDES every generic greeting/opening rule.',
    '',
    `The person tapped the topic "${content.topic_title}" in "My Journey" to have you explain it. Introduce it and TEACH it — proactively, in your OWN words.`,
    '',
    'STRICTLY FORBIDDEN — for the WHOLE session:',
    '- "What do you want?" / "How can I help you?" / "Where should we start?" — you KNOW what this is about: this topic.',
    '- Reading the script word-for-word. Use it as the BASIS and explain it naturally, conversationally.',
    '',
    `TOPIC: ${content.topic_title}`,
    'Teaching material (paraphrase, do NOT read aloud):',
    materialBlock,
    '',
    'How to lead:',
    '- Introduce the topic in 1–2 sentences, then explain it clearly and concretely in your own words.',
    '- Keep it conversational: short chunks, check understanding, answer follow-ups.',
    content.practice_target
      ? `- Once they get it, GUIDE them to the practice ("${content.practice_target}") — offer to do it together right now.`
      : '- Once they get it, propose a concrete next step.',
    '',
  ].join('\n');
}
