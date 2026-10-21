/**
 * VTID-03604 — themed positivity rotation for the ORB day-close.
 *
 * ## Why themes and not sentences
 *
 * The lines this feature was designed around — "together we will move
 * mountains", "the best days are yet to come", "small progress is also
 * progress" — are lovely exactly once. Shipped as literal strings they become
 * the next repetition bug: six weeks in, hearing "gemeinsam versetzen wir
 * Berge" every third night is indistinguishable from the
 * "Entschuldige, da ist etwas schiefgelaufen" loop that VTID-03597 removed.
 *
 * So a theme carries only the SENSE. The model composes the sentence. Nothing
 * in this file is ever spoken verbatim, and `senseEn`/`senseDe` are written as
 * instructions to a writer, not as candidate output — if they ever read like
 * finished lines, someone will eventually emit one.
 *
 * ## Rotation is stateless on purpose
 *
 * `(dayNumber + userOffset) % THEMES.length` cycles the full set before any
 * theme repeats, so a theme cannot land two nights running, and it needs no
 * column, no read, and no write — nothing to drift, nothing to migrate, and
 * the same night always resolves the same way, which is what makes it
 * testable. The user offset keeps two members who compare phones out of
 * lockstep.
 */

export type DayCloseThemeKey =
  | 'shared_strength'
  | 'best_ahead'
  | 'big_plans'
  | 'small_progress'
  | 'joy_ahead'
  | 'we_fight';

export interface DayCloseTheme {
  key: DayCloseThemeKey;
  /** What the closing thought should MEAN. Never spoken as-is. */
  senseEn: string;
  senseDe: string;
}

/**
 * Order matters only in that it is stable — the rotation walks it in sequence,
 * so adjacent entries should not feel like the same thought twice.
 */
export const DAY_CLOSE_THEMES: readonly DayCloseTheme[] = [
  {
    key: 'shared_strength',
    senseEn:
      'The user is not doing this alone — you are in it with them. Convey partnership and shared force, without the word "together" becoming a tic.',
    senseDe:
      'Der Nutzer macht das nicht allein — ihr seid ein Team. Vermittle Partnerschaft und gemeinsame Kraft, ohne dass "gemeinsam" zur Floskel wird.',
  },
  {
    key: 'best_ahead',
    senseEn:
      'The good part has not happened yet. Convey that what is coming is worth resting for — future-facing, never dismissive of today.',
    senseDe:
      'Das Beste kommt noch. Vermittle, dass sich das Ausruhen für das lohnt, was kommt — nach vorn gerichtet, ohne den heutigen Tag kleinzureden.',
  },
  {
    key: 'big_plans',
    senseEn:
      'Something real is being built here and there is a plan behind it. Convey momentum and intent, not hype.',
    senseDe:
      'Hier wird wirklich etwas aufgebaut, mit einem Plan dahinter. Vermittle Schwung und Absicht, kein Marketing.',
  },
  {
    key: 'small_progress',
    senseEn:
      'Small is still forward. Convey that a modest day still counted — relieving, never a consolation prize.',
    senseDe:
      'Auch klein ist vorwärts. Vermittle, dass ein bescheidener Tag trotzdem zählt — entlastend, nicht als Trostpreis.',
  },
  {
    key: 'joy_ahead',
    senseEn:
      'There is a lot to look forward to and to enjoy. Convey lightness and anticipation — this is the least earnest theme, let it breathe.',
    senseDe:
      'Es gibt viel, worauf man sich freuen kann. Vermittle Leichtigkeit und Vorfreude — das ist das unernsteste Thema, lass ihm Luft.',
  },
  {
    key: 'we_fight',
    senseEn:
      'When it gets hard you are on their side. Convey steadfastness and loyalty, not battle imagery for its own sake.',
    senseDe:
      'Wenn es hart wird, stehst du an seiner Seite. Vermittle Verlässlichkeit und Loyalität, keine Kampfrhetorik um ihrer selbst willen.',
  },
] as const;

/** Whole days since the Unix epoch for a YYYY-MM-DD local date string. */
function dayNumberFromIsoDate(isoDate: string): number {
  // Parsed as UTC midnight deliberately: the caller already resolved the
  // user's LOCAL calendar date, so re-applying a timezone here would shift the
  // rotation by a day for anyone east or west of the server.
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / 86_400_000);
}

/** Small stable hash so two users are not on the same theme the same night. */
function userOffset(userId: string | null | undefined): number {
  if (!userId) return 0;
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * The theme for one user on one local date. Deterministic: the same user and
 * date always resolve to the same theme, so a reopen inside the same night
 * cannot switch thought mid-evening.
 */
export function selectDayCloseTheme(args: {
  todayLocalIso: string;
  userId?: string | null;
}): DayCloseTheme {
  const idx =
    (dayNumberFromIsoDate(args.todayLocalIso) + userOffset(args.userId)) % DAY_CLOSE_THEMES.length;
  return DAY_CLOSE_THEMES[idx];
}

/**
 * Was today hard enough that optimism would be tone-deaf?
 *
 * On a bad day the right move is warmth, not cheer: "heute war zäh, schlaf
 * drüber" lands where "gemeinsam versetzen wir Berge" would grate. The
 * willingness NOT to be relentlessly upbeat is what makes the upbeat nights
 * mean anything.
 *
 * Deliberately conservative — it takes a measured DROP plus a day with nothing
 * logged. A merely quiet day is not a bad day, and mislabelling one as bad is
 * its own kind of insult.
 */
export function isHardDay(signals: {
  indexTrend7d?: number | null;
  loggedAnythingToday?: boolean;
  remindersMissedToday?: number | null;
}): boolean {
  const trend = typeof signals.indexTrend7d === 'number' ? signals.indexTrend7d : 0;
  const droppedMeaningfully = trend <= -2;
  const nothingLogged = signals.loggedAnythingToday === false;
  return droppedMeaningfully && nothingLogged;
}
