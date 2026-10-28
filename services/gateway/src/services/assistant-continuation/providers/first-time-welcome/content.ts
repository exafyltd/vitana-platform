/**
 * R6 (BOOTSTRAP-ORB-R6R7-PROVIDERS) — First-time-welcome content.
 *
 * VTID-04760: this used to hold two finished per-language scripts (DE + EN)
 * that Vitana recited word for word, naming a "90-day starter plan". That is
 * exactly what NEVER-rule 41 (CLAUDE.md, VTID-03622) forbids — a hardcoded
 * spoken sentence that bypasses the FLEXIBLE WORDING rule — and the "90-day"
 * framing no longer matched anything the member can find in the app. The
 * provider now carries the INTENT of the welcome, written in English (§13b);
 * the model composes the actual words in the member's language at runtime.
 *
 * The welcome points the member at the one thing a shy, passive newcomer can
 * do without deciding anything: press play on Episode 1 of their Audiobook
 * (the guided journey, presented as listen-only episodes).
 */

export interface FirstTimeWelcomeIntentArgs {
  firstName: string | null;
}

/**
 * Marker the wake-brief block builder keys on (via the candidate's
 * dedupeKey prefix) to render this as a compositional opener instead of the
 * verbatim "speak exactly" block. Exported for the controller and tests.
 */
export const FIRST_TIME_WELCOME_DEDUPE_PREFIX = 'first-time-welcome:';

/**
 * Build the welcome INTENT. Pure. Exported for tests. Never a finished
 * sentence in the member's language — the model writes that.
 */
export function buildFirstTimeWelcomeIntent(args: FirstTimeWelcomeIntentArgs): string {
  const name = args.firstName ? `The member's first name is ${args.firstName}; greet them by it. ` : '';
  return (
    `${name}This is the member's very first conversation with you. ` +
    'Welcome them warmly to Maxina and introduce yourself as Vitana, their personal longevity companion. ' +
    'Reassure them that they do not need to figure anything out on their own and there is no rush. ' +
    'Tell them the easiest way to start is their Audiobook: short episodes in which you explain, ' +
    'step by step, how the community helps them live healthier and longer, and all they have to do is listen. ' +
    'Invite them to start Episode 1 now, and keep the whole welcome short.'
  );
}
