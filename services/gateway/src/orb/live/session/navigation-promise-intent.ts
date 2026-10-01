/**
 * VTID-04619 — Vitana says she is opening a page but never calls navigate.
 *
 * Production 2026-09-26 09:17 (session live-07f808a6, de, Nova Sonic): the
 * member asked three times to open the settings page. Each time Vitana said
 * "Ich öffne jetzt die Seite mit …" and made no tool call. The repeats were
 * muted as duplicate turns (VTID-03143), so the member saw Speaking →
 * Listening with no sound, over and over, and was never taken anywhere.
 *
 * This module recognises the announcement. The hook in
 * upstream-message-handler.ts runs the navigate tool itself when the turn
 * announced a navigation and none happened — the same shape as the
 * end_conversation (VTID-04592) and remember (VTID-04591) backstops.
 *
 * Only first-person, present/immediate statements count ("ich öffne jetzt",
 * "ich bringe dich zu", "I'm opening", "I'll take you to"). Offers and
 * questions ("soll ich die Seite öffnen?", "ich kann dir … zeigen",
 * "want me to open …") do not: the member has not agreed yet.
 *
 * Pure; DE and EN.
 */

const NAVIGATION_PROMISE_PATTERNS: RegExp[] = [
  // German
  /\bich\s+öffne\s+(dir\s+)?(jetzt\s+|gleich\s+|sofort\s+|mal\s+)?(die|den|das|deine|dein|deinen)\b/,
  /\bich\s+öffne\s+(dir\s+)?(jetzt|gleich|sofort)\b/,
  /\bich\s+(leite|bringe|führe|navigiere)\s+dich\s+(jetzt\s+|gleich\s+|sofort\s+)?(weiter|zu|zur|zum|in|auf|dorthin|hin)\b/,
  /\bich\s+navigiere\s+(jetzt\s+|gleich\s+)?(zu|zur|zum|in|auf)\b/,
  /\bich\s+wechsle\s+(jetzt\s+|gleich\s+)?(zu|zur|zum|in|auf)\b/,
  // English
  /\b(i'?m|i\s+am)\s+(now\s+)?(opening|taking\s+you|bringing\s+you|navigating|redirecting\s+you|sending\s+you)\b/,
  /\b(i'?ll|i\s+will)\s+(now\s+)?(open|take\s+you|bring\s+you|navigate|redirect\s+you)\b/,
  /\b(opening|taking\s+you\s+to)\s+(the|your)\s+\w+\s+(page|screen|settings)\s+now\b/,
];

const OFFER_OR_QUESTION = /\b(soll\s+ich|möchtest\s+du|willst\s+du|shall\s+i|should\s+i|do\s+you\s+want|want\s+me\s+to|would\s+you\s+like)\b/;

function normalize(text: string): string {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Vitana's reply this turn says she is opening / taking the member to a page. */
export function detectNavigationPromise(assistantText: string): boolean {
  const t = normalize(assistantText);
  if (!t) return false;
  // Split into sentences so an offer in one sentence doesn't veto a promise
  // in another, and a promise inside a question doesn't count.
  const sentences = t.split(/(?<=[.!?])\s+/);
  return sentences.some(
    (s) => !s.endsWith('?') && !OFFER_OR_QUESTION.test(s) && NAVIGATION_PROMISE_PATTERNS.some((p) => p.test(s)),
  );
}

/**
 * The question handed to the navigate tool: what Vitana said she'd open plus
 * what the member asked for. The navigator matches it against the screen
 * registry exactly as it would a model-written question.
 */
export function buildBackstopNavigateQuestion(assistantText: string, userText: string): string {
  const a = (assistantText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const u = (userText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return [a, u].filter(Boolean).join(' — ');
}

export function isNavigateBackstopEnabled(): boolean {
  return (process.env.ORB_NAVIGATE_BACKSTOP_ENABLED ?? 'true') !== 'false';
}

export const NAVIGATE_TOOL_NAMES = new Set(['navigate', 'navigate_to_screen']);
