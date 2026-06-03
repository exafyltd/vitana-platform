/**
 * R7 (BOOTSTRAP-ORB-R6R7-PROVIDERS) — Goal-completion-inquiry spoken content.
 *
 * The celebration + invitation Vitana speaks when the user's active Life
 * Compass goal has reached its target date. A short script that:
 *   1. Celebrates hitting the target.
 *   2. Invites the next goal OR a pause — the user's choice.
 *
 * DE is the default community locale → real native translation. EN second.
 * Lang fallback chain: requested lang → 'en'.
 *
 * Content lives beside the provider (not in `orb/live/instruction/*`),
 * matching the new-day-return / Teacher / first-time-welcome pattern.
 */

export interface GoalCompletionRenderArgs {
  lang: string;
  firstName: string | null;
  /** The completed goal's text, woven in when available. */
  goalText: string | null;
}

interface GoalCompletionScript {
  /** Celebration + invitation, with a `{goal}` clause when goal text is known. */
  withGoal: string;
  /** Celebration + invitation without naming the specific goal. */
  withoutGoal: string;
}

const GOAL_COMPLETION_SCRIPTS: Record<string, GoalCompletionScript> = {
  de: {
    withGoal:
      'Du hast dein Ziel erreicht — "{goal}". Das ist großartig, herzlichen Glückwunsch! ' +
      'Möchtest du gleich das nächste Ziel gemeinsam setzen, oder erst einmal kurz durchatmen und den Moment genießen?',
    withoutGoal:
      'Du hast dein Ziel erreicht — das ist großartig, herzlichen Glückwunsch! ' +
      'Möchtest du gleich das nächste Ziel gemeinsam setzen, oder erst einmal kurz durchatmen und den Moment genießen?',
  },
  en: {
    withGoal:
      'You hit your target — "{goal}". That is huge, congratulations! ' +
      'Want to set the next one together, or take a moment first and enjoy it?',
    withoutGoal:
      'You hit your target — that is huge, congratulations! ' +
      'Want to set the next one together, or take a moment first and enjoy it?',
  },
};

/** Optional leading name clause, locale-aware. */
function namePrefix(lang: string, firstName: string | null): string {
  if (!firstName) return '';
  // Both locales front a short name address; the script itself stays
  // grammatical without it, so this is purely a warmth add.
  return lang === 'de' ? `${firstName}, ` : `${firstName}, `;
}

/** Locales that ship a real authored script. Exported for tests. */
export const GOAL_COMPLETION_LOCALES = Object.keys(GOAL_COMPLETION_SCRIPTS);

/**
 * Render the goal-completion-inquiry spoken line. Pure. Exported for tests.
 * Falls back to EN for unknown locales; weaves goalText + firstName when known.
 */
export function renderGoalCompletionLine(args: GoalCompletionRenderArgs): string {
  const script = GOAL_COMPLETION_SCRIPTS[args.lang] ?? GOAL_COMPLETION_SCRIPTS.en;
  const goal = args.goalText?.trim();
  const base = goal
    ? script.withGoal.replace('{goal}', goal)
    : script.withoutGoal;
  const prefix = namePrefix(args.lang, args.firstName);
  if (!prefix) return base;
  // Lower-case the first letter of the base so the name prefix reads as a
  // natural address ("Dragan, you hit your target…").
  return prefix + base.charAt(0).toLowerCase() + base.slice(1);
}
