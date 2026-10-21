/**
 * VTID-05099 — a member's local calendar date and minute of the day.
 * Unknown or invalid time zones fall back to Europe/Berlin (the community's
 * home zone, same fallback as the onboarding coach).
 */
export const FALLBACK_TIME_ZONE = 'Europe/Berlin';

function zoneOrFallback(tz: string | null | undefined): string {
  if (!tz) return FALLBACK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

export interface LocalTime {
  /** YYYY-MM-DD */
  date: string;
  /** minutes after local midnight, 0..1439 */
  minuteOfDay: number;
}

export function localTime(now: Date, tz: string | null | undefined): LocalTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zoneOrFallback(tz),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minuteOfDay: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** The calendar date `days` before `date` (YYYY-MM-DD). */
export function minusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
