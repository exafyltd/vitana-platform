/**
 * VTID-04668: how the developer listings (the developer/admin/infra lineup
 * and GET /dev-autopilot/pending-approvals) use the P2 score.
 *
 *  - Order: priority_score desc, unscored rows last, then the caller's own
 *    tie-break (risk rank for the approval inbox, impact/created for the
 *    lineup).
 *  - Open rows (status new/snoozed) whose stored quality is below the floor
 *    are left out and counted in below_floor_count, unless the caller asks
 *    for them (?include_below_floor=1).
 *  - Unscored rows (quality NULL — written before this VTID, or not yet
 *    rescored) are kept: "unknown" is not "below the floor".
 */
import { passesQualityFloor, resolveQualityFloor, type QualityComponents, type QualityFloor } from './priority';

export interface QualityListingRow {
  status?: string | null;
  priority_score?: number | null;
  quality?: unknown;
}

export interface QualityListingOptions {
  includeBelowFloor?: boolean;
  floor?: QualityFloor;
  tiebreak?: (a: Record<string, unknown>, b: Record<string, unknown>) => number;
}

export interface QualityListingResult<T> {
  rows: T[];
  below_floor_count: number;
}

const OPEN_STATUSES = new Set(['new', 'snoozed']);

export function isOpenRow(row: QualityListingRow): boolean {
  return !row.status || OPEN_STATUSES.has(row.status);
}

export function qualityOf(row: QualityListingRow): (QualityComponents & Record<string, unknown>) | null {
  const q = row.quality;
  return q && typeof q === 'object' && !Array.isArray(q) ? (q as QualityComponents & Record<string, unknown>) : null;
}

/** True when the row is open, scored, and below the floor. */
export function isBelowFloor(row: QualityListingRow, floor: QualityFloor = resolveQualityFloor()): boolean {
  if (!isOpenRow(row)) return false;
  const q = qualityOf(row);
  return !!q && !passesQualityFloor(q, floor);
}

function priorityOf(row: QualityListingRow): number | null {
  const n = Number(row.priority_score);
  return row.priority_score !== null && row.priority_score !== undefined && Number.isFinite(n) ? n : null;
}

/** Stable sort: priority desc (nulls last), then tie-break, then input order. */
export function sortByPriority<T extends QualityListingRow>(
  rows: T[],
  tiebreak?: (a: Record<string, unknown>, b: Record<string, unknown>) => number,
): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const pa = priorityOf(a.row);
      const pb = priorityOf(b.row);
      if (pa === null && pb !== null) return 1;
      if (pb === null && pa !== null) return -1;
      if (pa !== null && pb !== null && pa !== pb) return pb - pa;
      const t = tiebreak ? tiebreak(a.row as Record<string, unknown>, b.row as Record<string, unknown>) : 0;
      return t || a.i - b.i;
    })
    .map((x) => x.row);
}

export function applyDeveloperQualityListing<T extends QualityListingRow>(
  rows: T[],
  opts: QualityListingOptions = {},
): QualityListingResult<T> {
  const floor = opts.floor || resolveQualityFloor();
  let below = 0;
  const kept: T[] = [];
  for (const r of rows || []) {
    if (isBelowFloor(r, floor)) {
      below++;
      if (!opts.includeBelowFloor) continue;
    }
    kept.push(r);
  }
  return { rows: sortByPriority(kept, opts.tiebreak), below_floor_count: below };
}
