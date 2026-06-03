/**
 * R6 (BOOTSTRAP-ORB-R6R7-PROVIDERS) — First-time-welcome spoken content.
 *
 * The one-time self-introduction Vitana speaks on the user's very first
 * orb session. A ~4–5 sentence script that:
 *   1. Names herself + her role ("your longevity companion").
 *   2. Frames the relationship ("together, one step at a time").
 *   3. Names the 90-day default starter plan.
 *   4. Invites the user's first goal.
 *
 * DE is the default community locale, so the German script is a REAL,
 * native translation — not a machine gloss. EN is the second authored
 * locale. Lang fallback chain: requested lang → 'en'.
 *
 * Content is kept here (not in `orb/live/instruction/*`) so the provider
 * owns its own copy, matching the new-day-return / Teacher pattern where
 * user-facing text lives beside the provider, not in the prompt assembler.
 */

export interface FirstTimeWelcomeRenderArgs {
  lang: string;
  firstName: string | null;
}

/**
 * Per-locale scripts. Each entry has a `{name}` placeholder used only in
 * the withName variant. Both variants are full 4–5 sentence scripts that
 * stand alone as a spoken Say-exactly opener.
 */
const WELCOME_SCRIPTS: Record<
  string,
  { withName: string; withoutName: string }
> = {
  de: {
    withName:
      'Hallo {name}, und herzlich willkommen. Ich bin Vitana, deine Langlebigkeits-Begleiterin. ' +
      'Gemeinsam setzen wir dein erstes Ziel und wachsen Schritt für Schritt in die Plattform hinein — ' +
      'ganz in deinem Tempo, ohne Eile. Den Anfang macht dein 90-Tage-Starterplan, der dir den Einstieg ganz natürlich erleichtert. ' +
      'Erzähl mir zum Start: Was möchtest du als Erstes für dich erreichen?',
    withoutName:
      'Herzlich willkommen. Ich bin Vitana, deine Langlebigkeits-Begleiterin. ' +
      'Gemeinsam setzen wir dein erstes Ziel und wachsen Schritt für Schritt in die Plattform hinein — ' +
      'ganz in deinem Tempo, ohne Eile. Den Anfang macht dein 90-Tage-Starterplan, der dir den Einstieg ganz natürlich erleichtert. ' +
      'Erzähl mir zum Start: Was möchtest du als Erstes für dich erreichen?',
  },
  en: {
    withName:
      'Hello {name}, and a warm welcome. I am Vitana, your longevity companion. ' +
      'Together we will set your first goal and grow into the platform one step at a time — ' +
      'at your own pace, with no rush. We will begin with your 90-day starter plan, which eases you in naturally. ' +
      'To get us started, tell me: what is the first thing you would like to achieve for yourself?',
    withoutName:
      'A warm welcome. I am Vitana, your longevity companion. ' +
      'Together we will set your first goal and grow into the platform one step at a time — ' +
      'at your own pace, with no rush. We will begin with your 90-day starter plan, which eases you in naturally. ' +
      'To get us started, tell me: what is the first thing you would like to achieve for yourself?',
  },
};

/** Locales that ship a real authored welcome. Exported for tests. */
export const FIRST_TIME_WELCOME_LOCALES = Object.keys(WELCOME_SCRIPTS);

/**
 * Render the first-time-welcome spoken line. Pure. Exported for tests.
 * Falls back to EN for unknown locales; substitutes firstName when known.
 */
export function renderFirstTimeWelcomeLine(args: FirstTimeWelcomeRenderArgs): string {
  const script = WELCOME_SCRIPTS[args.lang] ?? WELCOME_SCRIPTS.en;
  const template = args.firstName ? script.withName : script.withoutName;
  return args.firstName ? template.replace('{name}', args.firstName) : template;
}
