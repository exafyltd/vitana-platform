/**
 * VTID-04420 (Plan v1 WS-2.1) — the one phrasing rule for every opening.
 *
 * The brain splits an opening into WHAT to say (the candidates the continuation
 * providers return, ranked by `decideContinuation`) and HOW to say it (the
 * greeting rungs in `compute-greeting-decision.ts`). Every rung that asks the
 * model to speak now shares one rule: the model is given an intent and
 * composes the words itself, in the user's language. No rung hands the model a
 * finished sentence to recite.
 *
 * Why this matters, measured, not assumed:
 *  - CLAUDE.md NEVER-rule 41 / §13b: a sentence Vitana speaks is written as an
 *    intent, never as text. A hardcoded line overrides the system prompt's
 *    flexible-wording rule and is invisible to the anti-repeat mechanisms.
 *  - VTID-03797: guided-topic sessions were blocked by Nova 93/93 while their
 *    trigger said "say this prepared line" — the verbatim-recitation shape is
 *    what Bedrock's guardrail scores as injection-like.
 *  - VTID-04124: the rule is stated positively. A stack of prohibitions next to
 *    it is the other shape the guardrail reacts to.
 *
 * Two rungs still recited finished sentences until this change:
 * `safe_fast_first_time_welcome` (a per-language welcome speech) and
 * `safe_fast_newday` (a per-language "Good morning, <name>." map that only
 * covered five languages, so a Polish or Arabic session fell back to English).
 * Both now use `buildOpeningIntentDirective`.
 */

/** The phrasing rule every speaking rung carries. Positive-only on purpose. */
export const PHRASING_RULE =
  "Compose the wording yourself, in the user's own language, in your own words, choosing fresh wording every time.";

/**
 * Build a turn-1 directive from an intent. `intent` describes what the opening
 * should do (in English, never a quoted sentence); `shape` states the length.
 */
export function buildOpeningIntentDirective(intent: string, shape: 'one_phrase' | 'short_welcome' = 'one_phrase'): string {
  const opener =
    shape === 'one_phrase'
      ? 'Open with ONE short spoken phrase, as audio.'
      : 'Open with a short, warm spoken welcome of two or three sentences, as audio.';
  return `${opener} INTENT: ${intent.trim()} ${PHRASING_RULE} Then stop and listen.`;
}

/**
 * The shape the phrasing rule forbids: a directive that asks the model to
 * reproduce supplied text word for word. Used by the invariant test that walks
 * every rung, and available to any future rung author as a self-check.
 */
const VERBATIM_RECITATION_RE = /\bsay exactly\b|\bverbatim\b|\bword for word\b/i;

export function isVerbatimRecitationDirective(directive: string | null | undefined): boolean {
  if (!directive) return false;
  // "do not recite the lead word for word" is the opposite instruction and is allowed.
  const withoutNegatedRecital = directive.replace(/\bdo not recite\b[^.]*?\bword for word\b/gi, '');
  return VERBATIM_RECITATION_RE.test(withoutNegatedRecital);
}
