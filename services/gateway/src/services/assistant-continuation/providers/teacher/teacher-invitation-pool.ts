/**
 * VTID-03092 (Teacher PR 2) — invitation pool for the Teacher
 * (Feature Discovery Coach).
 *
 * The Teacher's spoken first turn is built as TWO clauses concatenated:
 *
 *   [greeting clause]  +  [invitation clause]
 *
 * This module owns the INVITATION clause only — the permission-asking
 * second sentence that offers to introduce ONE unexplored Vitanaland
 * feature. The greeting clause comes from `teacher-greeting-pool.ts`.
 *
 * Hard rules baked into this pool:
 *   - Every phrase asks PERMISSION ("Darf ich…?", "Hast du kurz Zeit?",
 *     "Magst du…?") — Vitana never assumes the user wants to be taught.
 *   - No "How can I help you?" / "Wie kann ich dir helfen?" — the
 *     Teacher's contract is "I want to introduce something to you",
 *     not "tell me what you want". The user has been clear about this.
 *   - No feature name is hardcoded here. The picked capability's
 *     display_name is substituted via `{featureLabel}` at render time —
 *     a few phrases name the feature, others stay abstract ("etwas
 *     Neues", "something I want to show you") so we can rotate without
 *     forcing the user to hear the capability name twice.
 *   - All phrases end in a question mark (permission-asking).
 *
 * Pool size target: ~20 per language so Gemini's recency bias doesn't
 * lock onto a single phrasing across the user's first 20+ sessions.
 */

const INVITATION_PHRASES: Record<string, string[]> = {
  en: [
    'May I show you something?',
    'Do you have a moment? I would like to introduce something to you.',
    'Would you like to see {featureLabel}?',
    'May I introduce you to {featureLabel}?',
    'Got a minute? I would love to show you something.',
    'Is now a good time to show you something new?',
    'May I take a minute to introduce something?',
    'Would you like a quick tour of {featureLabel}?',
    'I have something I would love to show you — interested?',
    'Got a minute for a small discovery?',
    'May I introduce one of our community features to you?',
    'Would you like to learn about {featureLabel}?',
    'Could I quickly walk you through {featureLabel}?',
    'Do you have a couple of minutes for something new?',
    'May I show you what {featureLabel} can do?',
    'Got time for a 30-second introduction?',
    'Would you like me to show you around {featureLabel}?',
    'I would like to introduce you to {featureLabel} — okay?',
    'May I share something about our community with you?',
    'Want to discover something new in Vitanaland?',
  ],
  de: [
    'Darf ich dir kurz etwas zeigen?',
    'Hast du einen Moment? Ich möchte dir etwas vorstellen.',
    'Magst du, dass ich dir {featureLabel} zeige?',
    'Darf ich dir {featureLabel} vorstellen?',
    'Hast du eine Minute? Ich würde dir gerne etwas zeigen.',
    'Passt es dir gerade, wenn ich dir etwas Neues zeige?',
    'Darf ich dir kurz {featureLabel} näherbringen?',
    'Magst du eine kleine Tour durch {featureLabel}?',
    'Ich habe etwas, das ich dir gerne zeigen würde — interessiert?',
    'Hast du Lust auf eine kleine Entdeckung?',
    'Darf ich dir eine unserer Community-Funktionen vorstellen?',
    'Magst du mehr über {featureLabel} erfahren?',
    'Soll ich dich kurz durch {featureLabel} führen?',
    'Hast du ein paar Minuten für etwas Neues?',
    'Darf ich dir zeigen, was {featureLabel} dir bringt?',
    'Hast du Zeit für eine 30-Sekunden-Einführung?',
    'Magst du, dass ich dich durch {featureLabel} führe?',
    'Ich würde dir gerne {featureLabel} vorstellen — passt das?',
    'Darf ich dir etwas aus unserer Community zeigen?',
    'Magst du etwas Neues in Vitanaland entdecken?',
  ],
};

/**
 * Pick one invitation phrase, substituting `{featureLabel}` when supplied.
 *
 * When no feature label is given (e.g. the first call when the Teacher
 * just wants to ask "may I introduce something" without naming what),
 * the function filters the pool to entries that don't reference
 * `{featureLabel}`.
 *
 * Pure function. Caller supplies the random source for deterministic tests.
 */
export function pickTeacherInvitation(args: {
  lang: string;
  featureLabel?: string | null;
  rng?: () => number;
}): string {
  const lang = (args.lang || 'en').toLowerCase();
  const pool = INVITATION_PHRASES[lang] || INVITATION_PHRASES.en;
  const hasLabel = !!(args.featureLabel && args.featureLabel.trim().length > 0);
  const eligible = hasLabel ? pool : pool.filter((p) => !p.includes('{featureLabel}'));
  // Defensive: every lang has phrases without `{featureLabel}`; fall back
  // to en's no-label subset if the lang somehow lacks them.
  const finalPool =
    eligible.length > 0
      ? eligible
      : INVITATION_PHRASES.en.filter((p) => !p.includes('{featureLabel}'));
  const rng = args.rng ?? Math.random;
  const idx = Math.floor(rng() * finalPool.length) % finalPool.length;
  const raw = finalPool[idx];
  return hasLabel ? raw.replace('{featureLabel}', args.featureLabel!.trim()) : raw;
}

/** Exported for the Command Hub "Teach Vitanaland" panel. */
export function listTeacherInvitations(lang: string): string[] {
  return INVITATION_PHRASES[(lang || 'en').toLowerCase()] || INVITATION_PHRASES.en;
}
