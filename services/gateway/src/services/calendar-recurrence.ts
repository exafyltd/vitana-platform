/**
 * VTID-04331 — expand a recurring calendar entry into its occurrences.
 *
 * Supports exactly what the valid_rrule CHECK allows: FREQ=DAILY|WEEKLY|
 * MONTHLY with INTERVAL, COUNT, UNTIL (UTC) and BYDAY (weekly). The entry's
 * start_time is DTSTART; every occurrence has the same duration.
 *
 * Expansion runs in the entry's local wall clock (its `timezone`, else the
 * user's), so a 07:30 habit stays at 07:30 across a DST change instead of
 * drifting to 06:30 or 08:30. Pure: no I/O, deterministic for a given input.
 */

export interface ParsedRRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  count: number | null;
  until: number | null; // epoch ms
  byday: number[] | null; // 0 = Sunday … 6 = Saturday, sorted Monday-first
}

const DAY_CODES: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_ITERATIONS = 5000;

export function parseRRule(rule: string): ParsedRRule | null {
  const parts = rule.split(';');
  const map = new Map<string, string>();
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i <= 0) return null;
    map.set(p.slice(0, i), p.slice(i + 1));
  }
  const freq = map.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null;

  const interval = map.has('INTERVAL') ? Number(map.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;

  const count = map.has('COUNT') ? Number(map.get('COUNT')) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;

  let until: number | null = null;
  const u = map.get('UNTIL');
  if (u) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(u);
    if (!m) return null;
    until = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  let byday: number[] | null = null;
  const b = map.get('BYDAY');
  if (b) {
    byday = [];
    for (const code of b.split(',')) {
      if (!(code in DAY_CODES)) return null;
      byday.push(DAY_CODES[code]);
    }
    // Monday-first week order, de-duplicated.
    byday = [...new Set(byday)].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));
  }

  return { freq, interval, count, until, byday };
}

interface LocalParts { y: number; mo: number; d: number; h: number; mi: number; s: number }

export function localParts(epochMs: number, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p.year, mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

function offsetMs(epochMs: number, tz: string): number {
  const l = localParts(epochMs, tz);
  return Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s) - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch ms of a local wall-clock time in `tz` (DST-aware; gaps resolve forward). */
export function zonedTimeToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = asUtc - offsetMs(asUtc, tz);
  t = asUtc - offsetMs(t, tz);
  return t;
}

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface Occurrence {
  start: string; // ISO
  end: string; // ISO
  index: number; // 0-based position in the series
}

export interface ExpandInput {
  start_time: string;
  end_time: string | null;
  rrule: string;
  timezone?: string | null;
}

/**
 * Occurrences of `event` that overlap [from, to). `fallbackTz` is used when
 * the entry has no (valid) timezone. `limit` caps the number returned.
 */
export function expandOccurrences(
  event: ExpandInput,
  window: { from: string; to: string },
  fallbackTz: string,
  limit = 500,
): Occurrence[] {
  const rule = parseRRule(event.rrule);
  const dtstart = Date.parse(event.start_time);
  if (!rule || Number.isNaN(dtstart)) return [];
  const end0 = event.end_time ? Date.parse(event.end_time) : NaN;
  const duration = Number.isNaN(end0) || end0 < dtstart ? 0 : end0 - dtstart;
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return [];

  const tz = event.timezone && isValidTz(event.timezone) ? event.timezone : fallbackTz;
  const s = localParts(dtstart, tz);
  // Calendar dates are walked as UTC-midnight "day numbers" — pure date math.
  const startDay = Date.UTC(s.y, s.mo - 1, s.d);
  const DAY = 86_400_000;

  const out: Occurrence[] = [];
  let emittedInSeries = 0;
  let iterations = 0;

  const consider = (dayMs: number): 'stop' | 'continue' => {
    const dt = new Date(dayMs);
    const startMs = zonedTimeToEpoch(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), s.h, s.mi, s.s, tz);
    if (startMs < dtstart) return 'continue';
    if (rule.until !== null && startMs > rule.until) return 'stop';
    if (rule.count !== null && emittedInSeries >= rule.count) return 'stop';
    if (startMs >= to) return 'stop';
    const index = emittedInSeries++;
    if (startMs + Math.max(duration, 1) > from) {
      out.push({ start: new Date(startMs).toISOString(), end: new Date(startMs + duration).toISOString(), index });
    }
    return out.length >= limit ? 'stop' : 'continue';
  };

  if (rule.freq === 'DAILY') {
    for (let day = startDay; iterations++ < MAX_ITERATIONS; day += rule.interval * DAY) {
      if (consider(day) === 'stop') break;
    }
  } else if (rule.freq === 'WEEKLY') {
    const weekdays = rule.byday ?? [new Date(startDay).getUTCDay()];
    const mondayOffset = (new Date(startDay).getUTCDay() + 6) % 7;
    let weekStart = startDay - mondayOffset * DAY;
    outer: while (iterations++ < MAX_ITERATIONS) {
      for (const wd of weekdays) {
        const day = weekStart + ((wd + 6) % 7) * DAY;
        if (day < startDay) continue;
        if (consider(day) === 'stop') break outer;
      }
      weekStart += rule.interval * 7 * DAY;
    }
  } else {
    // MONTHLY on the start day-of-month; months without that day are skipped (RFC 5545).
    for (let k = 0; iterations++ < MAX_ITERATIONS; k += rule.interval) {
      const y = s.y + Math.floor((s.mo - 1 + k) / 12);
      const mo = ((s.mo - 1 + k) % 12);
      const day = Date.UTC(y, mo, s.d);
      if (new Date(day).getUTCDate() !== s.d) continue; // e.g. 31 Feb
      if (consider(day) === 'stop') break;
    }
  }

  return out;
}
