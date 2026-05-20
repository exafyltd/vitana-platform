/**
 * VTID-03092 (Teacher PR 2) — name-aware greeting pool for the Teacher
 * (Feature Discovery Coach).
 *
 * The Teacher's spoken first turn is built as TWO clauses concatenated:
 *
 *   [greeting clause]  +  [invitation clause]
 *
 * This module owns the GREETING clause only. It picks one warm,
 * service-grade phrase that acknowledges the user's return (using
 * their first name when known). The invitation clause comes from
 * `teacher-invitation-pool.ts` and asks permission to introduce ONE
 * unexplored Vitanaland feature.
 *
 * Hard rules baked into this pool:
 *   - No dismissive openers ("Yes?", "Ja bitte?", "What's up?").
 *   - Every phrase ends in a period — the invitation appends after.
 *   - Phrases with `{firstName}` substitute the user's first name when
 *     available; phrases without it are the no-name fallback set.
 *   - All phrases use the user's language. Unsupported langs fall back
 *     to English.
 *
 * Pool size target: ~20 per language (mix of with-name + no-name
 * variants) so Gemini's recency bias is broken across sessions.
 */

const GREETING_PHRASES: Record<string, string[]> = {
  en: [
    'Welcome back, {firstName}.',
    'Hi again, {firstName}.',
    'Good to see you again, {firstName}.',
    'Glad you are back, {firstName}.',
    'Nice to hear you, {firstName}.',
    'Welcome back.',
    'Hi again.',
    'Good to have you back.',
    'It is good to hear from you, {firstName}.',
    'Welcome, {firstName}.',
    'Lovely to see you again, {firstName}.',
    'Hello again, {firstName}.',
    'Hi, {firstName}. Good to have you back.',
    'It is great that you are here, {firstName}.',
    'Welcome back to Vitanaland, {firstName}.',
    'I am happy you are here, {firstName}.',
    'Good to have you with us again, {firstName}.',
    'Hi, {firstName}. Glad you stopped by.',
    'Welcome back. It is good to hear you.',
    'Hello again. Nice to hear you.',
  ],
  de: [
    'Willkommen zurück, {firstName}.',
    'Schön, dich wieder zu hören, {firstName}.',
    'Hallo {firstName}, schön, dass du wieder da bist.',
    'Schön, dass du wieder hier bist, {firstName}.',
    'Hi {firstName}, schön dich zu sehen.',
    'Willkommen zurück.',
    'Schön, dich wieder zu hören.',
    'Schön, dass du wieder da bist.',
    'Schön, von dir zu hören, {firstName}.',
    'Hallo nochmal, {firstName}.',
    'Schön, dich zu sehen, {firstName}.',
    'Ich freue mich, dass du wieder da bist, {firstName}.',
    'Hi {firstName}, willkommen zurück.',
    'Toll, dass du wieder hier bist, {firstName}.',
    'Willkommen zurück in Vitanaland, {firstName}.',
    'Ich freue mich, dich wieder zu hören, {firstName}.',
    'Schön, dass du da bist, {firstName}.',
    'Gut, dich wieder zu hören, {firstName}.',
    'Willkommen zurück. Schön, dich zu hören.',
    'Hallo nochmal. Schön, von dir zu hören.',
  ],
};

/**
 * VTID-03105: meta variant of pickTeacherGreeting. Returns the picked
 * text PLUS the index inside the final (post-filter) pool and the pool
 * size. Used by feature-discovery-teacher.ts for the diagnostic log so
 * we can confirm in production whether Math.random is actually rotating
 * across sessions. The classic `pickTeacherGreeting` stays as a thin
 * `.text` wrapper for backward compatibility with the Command Hub
 * panel + existing tests.
 */
export interface TeacherGreetingPick {
  text: string;
  rawTemplate: string;
  idx: number;
  poolSize: number;
}

export function pickTeacherGreetingMeta(args: {
  lang: string;
  firstName?: string | null;
  rng?: () => number;
}): TeacherGreetingPick {
  const lang = (args.lang || 'en').toLowerCase();
  const pool = GREETING_PHRASES[lang] || GREETING_PHRASES.en;
  const hasName = !!(args.firstName && args.firstName.trim().length > 0);
  const eligible = hasName ? pool : pool.filter((p) => !p.includes('{firstName}'));
  // Defensive: if a lang lacks no-name phrases, fall back to en's no-name set.
  const finalPool =
    eligible.length > 0 ? eligible : GREETING_PHRASES.en.filter((p) => !p.includes('{firstName}'));
  const rng = args.rng ?? Math.random;
  const idx = Math.floor(rng() * finalPool.length) % finalPool.length;
  const raw = finalPool[idx];
  const text = hasName ? raw.replace('{firstName}', args.firstName!.trim()) : raw;
  return { text, rawTemplate: raw, idx, poolSize: finalPool.length };
}

/**
 * Pick one greeting phrase, substituting `{firstName}` when supplied.
 *
 * When no name is available, the function filters the pool to entries
 * that don't reference `{firstName}` so we never speak the literal
 * placeholder. When the name IS available we keep the full pool.
 *
 * Pure function. Caller supplies the random source (defaults to
 * Math.random) so tests can pin the choice deterministically.
 */
export function pickTeacherGreeting(args: {
  lang: string;
  firstName?: string | null;
  rng?: () => number;
}): string {
  return pickTeacherGreetingMeta(args).text;
}

/**
 * Exported for the Command Hub "Teach Vitanaland" panel — operators
 * inspect the full pool in the read-only "Phrase Pools" section.
 */
export function listTeacherGreetings(lang: string): string[] {
  return GREETING_PHRASES[(lang || 'en').toLowerCase()] || GREETING_PHRASES.en;
}
