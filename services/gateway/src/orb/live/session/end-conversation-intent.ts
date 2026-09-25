/**
 * VTID-04592 — end the conversation when the member asked to stop AND
 * Vitana's own reply agreed to stop, even if the model never called the
 * `end_conversation` tool.
 *
 * Production session live-6786b50c (2026-09-25 22:39 UTC, de, Nova Sonic):
 * the member asked to stop nine times ("du sollst gehen", "geh jetzt",
 * "schalte ab", "schluss" x4). Vitana answered "Ich schalte mich jetzt ab" /
 * "Ich beende jetzt das Gespräch" every time and made zero tool calls, so the
 * widget went back to listening after each farewell. The VTID-03824 backstop
 * only matches the "du bist (immer) noch da" complaint, which the member
 * never said.
 *
 * Two signals, both required, both from the same turn:
 *   1. the member's utterance asks to end or leave the conversation, and
 *   2. the assistant's reply says it is ending / leaving / saying goodbye.
 * Either alone is not enough: "hör auf" can mean "stop this answer" (the
 * reply then carries on helping, so signal 2 is absent), and Vitana may say
 * "bis später" at the end of a normal answer (signal 1 absent).
 *
 * Pure; EN and DE, the languages the existing backstop covers.
 */

const USER_STOP_PATTERNS: RegExp[] = [
  // German
  /\bschlu(ss|ß)\b/,
  /\btsch(ü|u)(ss?|ß)\b/,
  /\bauf\s+wiedersehen\b/,
  /\bgeh(\s+jetzt|\s+weg)\b/,
  /\bdu\s+(sollst|kannst|darfst)\s+(jetzt\s+)?(gehen|aufh(ö|o)ren)\b/,
  /\bschalt(e)?\s+(dich\s+)?(jetzt\s+)?(ab|aus)\b/,
  /\b(ab|aus)schalten\b/,
  /\bmach\s+(jetzt\s+)?(zu|aus|schlu(ss|ß))\b/,
  /\bbeend(e|en)\s+(jetzt\s+)?(das|die|unser(e)?)\s+(gespr(ä|a)ch|unterhaltung|sitzung)\b/,
  /\b(gespr(ä|a)ch|unterhaltung)\s+beenden\b/,
  /\bich\s+will\s+nicht\s+(mehr\s+)?mit\s+dir\s+reden\b/,
  /\blass\s+mich\s+in\s+ruhe\b/,
  /\bh(ö|o)r\s+auf\s+zu\s+reden\b/,
  // English
  /\bgood\s*bye\b/,
  /\bbye(\s+bye)?\b/,
  /\bgo\s+away\b/,
  /\b(shut|switch|turn)\s+(yourself\s+)?(down|off)\b/,
  /\bstop\s+talking\b/,
  /\bend\s+(the|this|our)\s+(conversation|session|call|chat)\b/,
  /\bleave\s+me\s+alone\b/,
  /\bi\s+don'?t\s+want\s+to\s+talk\s+(to\s+you\s+)?(any\s*more)?\b/,
];

const ASSISTANT_ENDING_PATTERNS: RegExp[] = [
  // German
  /\bich\s+beende\s+(jetzt\s+)?(das|unser(e)?|die)\s+(gespr(ä|a)ch|unterhaltung|sitzung)\b/,
  /\bich\s+schalte\s+mich\s+(jetzt\s+)?(ab|aus)\b/,
  /\bich\s+(gehe|verabschiede\s+mich)\b/,
  /\bich\s+bin\s+(jetzt\s+)?weg\b/,
  /\btsch(ü|u)(ss?|ß)\b/,
  /\bauf\s+wiedersehen\b/,
  /\bbis\s+(sp(ä|a)ter|bald|zum\s+n(ä|a)chsten\s+mal)\b/,
  /\bwir\s+sprechen\s+(uns\s+)?sp(ä|a)ter\b/,
  // English
  /\b(i'?m|i\s+am|i\s+will|i'?ll)\s+(now\s+)?(ending|end|closing|close)\s+(the|this|our)\s+(conversation|session|call|chat)\b/,
  /\b(i'?m|i\s+am)\s+(signing|logging|switching|shutting)\s+off\b/,
  /\bgood\s*bye\b/,
  /\btalk\s+(to\s+you\s+)?(later|soon)\b/,
];

function normalize(text: string): string {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The member's utterance asks to end or leave the conversation. */
export function detectUserStopIntent(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  return USER_STOP_PATTERNS.some((p) => p.test(t));
}

/** The assistant's reply says it is ending, leaving or saying goodbye. */
export function detectAssistantAgreedToEnd(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  return ASSISTANT_ENDING_PATTERNS.some((p) => p.test(t));
}

/** Both signals in the same turn: the conversation should close. */
export function shouldEndConversationAfterTurn(userText: string, assistantText: string): boolean {
  return detectUserStopIntent(userText) && detectAssistantAgreedToEnd(assistantText);
}
