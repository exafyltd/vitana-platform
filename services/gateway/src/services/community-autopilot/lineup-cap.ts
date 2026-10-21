/**
 * VTID-04523 (Community Autopilot): owner decision 3 — at most
 * MAX_OPEN_PER_ROLE open suggestions per member per role — held on both sides.
 *
 * The ranker already enforced the cap on WRITES (scan picks, automation
 * proposals), but the lineup READ served every open row, and rows written
 * before the cap existed stayed open: on staging all 33 members with open
 * community suggestions saw more than 3 (up to 15).
 *
 *   - `capOpenLineup`: read side. Keeps every non-open row (activated,
 *     completed) and only the first MAX_OPEN_PER_ROLE open ('new') rows of an
 *     already-ranked list.
 *   - `selectExcessOpenRows`: write side, used by the scan. Picks the open
 *     rows beyond the cap to retire (status auto_archived). Rows carrying a
 *     typed action are kept before legacy rows, then higher impact, then newer.
 */
import { MAX_OPEN_PER_ROLE } from './ranker';

export interface CapResult<T> {
  kept: T[];
  /** Open rows left out of this response. */
  capped: number;
}

export function capOpenLineup<T extends { status?: string | null }>(
  ranked: T[],
  max: number = MAX_OPEN_PER_ROLE,
): CapResult<T> {
  const kept: T[] = [];
  let open = 0;
  let capped = 0;
  for (const rec of ranked) {
    if (rec.status === 'new') {
      if (open >= max) { capped++; continue; }
      open++;
    }
    kept.push(rec);
  }
  return { kept, capped };
}

export interface OpenRow {
  id: string;
  action?: unknown;
  impact_score?: number | null;
  created_at?: string | null;
  expires_at?: string | null;
}

/** Ids of the open rows to retire so at most `max` stay open. Expired rows are ignored (they no longer show). */
export function selectExcessOpenRows(rows: OpenRow[], now: Date, max: number = MAX_OPEN_PER_ROLE): string[] {
  const live = rows.filter((r) => !(r.expires_at && Date.parse(r.expires_at) < now.getTime()));
  if (live.length <= max) return [];
  const typed = (r: OpenRow) => (r.action && typeof r.action === 'object' ? 1 : 0);
  const sorted = [...live].sort((a, b) =>
    typed(b) - typed(a)
    || (b.impact_score ?? 0) - (a.impact_score ?? 0)
    || Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? '')
    || a.id.localeCompare(b.id));
  return sorted.slice(max).map((r) => r.id);
}
