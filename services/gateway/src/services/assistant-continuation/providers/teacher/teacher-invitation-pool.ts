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
 * Hard rules baked into this pool (VTID-03256 — proactive-lead doctrine):
 *   - Every phrase LEADS or asks permission to LEAD ("Let me show you…",
 *     "I'd like to introduce…", "Darf ich…?" = may I). Vitana proposes the
 *     move and offers to take it. NEVER preference-asking — no "Would you
 *     like…?", "Magst du…?", "Do you want…?". A first-week user cannot answer
 *     a preference question; they don't know the system yet.
 *   - No "How can I help you?" / "Wie kann ich dir helfen?" — the
 *     Teacher's contract is "I want to introduce something to you",
 *     not "tell me what you want". The user has been clear about this.
 *   - No feature name is hardcoded here. The picked capability's
 *     display_name is substituted via `{featureLabel}` at render time —
 *     a few phrases name the feature, others stay abstract ("etwas
 *     Neues", "something I want to show you") so we can rotate without
 *     forcing the user to hear the capability name twice.
 *
 * Pool size target: ~20 per language so Gemini's recency bias doesn't
 * lock onto a single phrasing across the user's first 20+ sessions.
 */

const INVITATION_PHRASES: Record<string, string[]> = {
  en: [
    'May I show you something?',
    'I would like to introduce something to you.',
    'Let me show you {featureLabel}.',
    'May I introduce you to {featureLabel}?',
    'I would love to show you something — let me.',
    'Let me show you something new.',
    'Let me take a minute to introduce something.',
    'Let me give you a quick tour of {featureLabel}.',
    'I have something to show you — let me.',
    'Let me show you a small discovery.',
    'May I introduce one of our community features to you?',
    'Let me tell you about {featureLabel}.',
    'Let me walk you through {featureLabel}.',
    'I want to show you something new — may I?',
    'Let me show you what {featureLabel} can do.',
    'Let me give you a quick 30-second introduction.',
    'Let me show you around {featureLabel}.',
    'I would like to introduce you to {featureLabel} — may I?',
    'Let me share something about our community with you.',
    'Let me show you something new in Vitanaland.',
  ],
  de: [
    'Darf ich dir kurz etwas zeigen?',
    'Ich möchte dir etwas vorstellen.',
    'Lass mich dir {featureLabel} zeigen.',
    'Darf ich dir {featureLabel} vorstellen?',
    'Ich würde dir gerne etwas zeigen — lass mich.',
    'Lass mich dir etwas Neues zeigen.',
    'Darf ich dir kurz {featureLabel} näherbringen?',
    'Lass mich dir eine kleine Tour durch {featureLabel} geben.',
    'Ich habe etwas, das ich dir zeige.',
    'Lass mich dir eine kleine Entdeckung zeigen.',
    'Darf ich dir eine unserer Community-Funktionen vorstellen?',
    'Lass mich dir mehr über {featureLabel} erzählen.',
    'Lass mich dich durch {featureLabel} führen.',
    'Ich möchte dir etwas Neues zeigen — darf ich?',
    'Lass mich dir zeigen, was {featureLabel} dir bringt.',
    'Lass mich dir eine 30-Sekunden-Einführung geben.',
    'Lass mich dir {featureLabel} in Ruhe zeigen.',
    'Ich würde dir gerne {featureLabel} vorstellen — darf ich?',
    'Lass mich dir etwas aus unserer Community zeigen.',
    'Lass mich dir etwas Neues in Vitanaland zeigen.',
  ],
};

/**
 * VTID-03105: meta variant of pickTeacherInvitation. Returns the picked
 * text PLUS the index inside the final (post-filter) pool and the pool
 * size. Used by feature-discovery-teacher.ts for the diagnostic log so
 * we can confirm in production whether Math.random is actually rotating
 * across sessions. The classic `pickTeacherInvitation` stays as a thin
 * `.text` wrapper for backward compatibility.
 */
export interface TeacherInvitationPick {
  text: string;
  rawTemplate: string;
  idx: number;
  poolSize: number;
}

export function pickTeacherInvitationMeta(args: {
  lang: string;
  featureLabel?: string | null;
  rng?: () => number;
}): TeacherInvitationPick {
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
  const text = hasLabel ? raw.replace('{featureLabel}', args.featureLabel!.trim()) : raw;
  return { text, rawTemplate: raw, idx, poolSize: finalPool.length };
}

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
  return pickTeacherInvitationMeta(args).text;
}

/** Exported for the Command Hub "Teach Vitanaland" panel. */
export function listTeacherInvitations(lang: string): string[] {
  return INVITATION_PHRASES[(lang || 'en').toLowerCase()] || INVITATION_PHRASES.en;
}
