/**
 * VTID-05026 — the per-task daily Google character cap for Audiobook narration.
 *
 * Owner decision 2026-10-05 (cost option a). `AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK`
 * is an integer: characters each gateway task may send to Google per UTC day.
 * Unset, 0, negative or not a number → Google narration is off, so the cap has
 * to be set deliberately.
 *
 * APPROXIMATE BY DESIGN. The count lives in this process's memory: it resets
 * at 00:00 UTC and on every deploy, and every running task has its own. The
 * real daily budget is therefore about cap × running tasks, and a deploy day
 * can spend up to roughly twice that (a fresh cap after a mid-day deploy).
 * That residual was accepted with option (a); the CloudWatch metric filter on
 * the per-render log line (`scripts/aws/setup-audiobook-google-metric.sh`)
 * shows the real total.
 *
 * At the cap, ru and sr answer 422 narration_unavailable for the rest of the
 * UTC day — never another language's voice. Cached episodes keep playing.
 */

export function readAudiobookGoogleDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK ?? '').trim();
  if (!/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : 0;
}

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

let day = '';
let used = 0;
let capLoggedForDay = '';

/**
 * Reserve `chars` against today's cap. True when the render may go ahead
 * (the characters are then counted, whether or not Google succeeds — Google
 * bills the request). False when it would pass the cap; logs once per day.
 */
export function reserveAudiobookGoogleChars(
  chars: number,
  opts: { env?: NodeJS.ProcessEnv; now?: Date } = {},
): boolean {
  const cap = readAudiobookGoogleDailyCap(opts.env);
  if (cap <= 0) return false;
  const today = utcDay(opts.now ?? new Date());
  if (today !== day) {
    day = today;
    used = 0;
  }
  if (used + chars > cap) {
    if (capLoggedForDay !== today) {
      capLoggedForDay = today;
      console.warn(
        `[AUDIOBOOK-GOOGLE-TTS] daily cap reached on this task (used=${used} cap=${cap} day=${today}); ` +
          'ru/sr narration answers 422 until 00:00 UTC',
      );
    }
    return false;
  }
  used += chars;
  return true;
}

/** Characters reserved today on this task. */
export function audiobookGoogleCharsUsedToday(now: Date = new Date()): number {
  return utcDay(now) === day ? used : 0;
}

/** Test hook. */
export function __resetAudiobookGoogleBudgetForTests(): void {
  day = '';
  used = 0;
  capLoggedForDay = '';
}
