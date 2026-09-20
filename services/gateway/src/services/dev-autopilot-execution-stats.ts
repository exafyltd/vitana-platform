/**
 * VTID-04204 — pure aggregation over Dev Autopilot execution records, with
 * no DB access of its own, so it can be unit-tested without a live
 * database and wired into a read-only Operator Console tool later.
 *
 * Deliberately does NOT enumerate a fixed set of status literals (e.g.
 * `{queued, running, awaiting_approval, completed, failed, cancelled}`)
 * and zero-fill the absent ones. `dev_autopilot_executions.status` has
 * grown its own set of values over time as this platform's own CHANGE LOG
 * records (cooling/running/awaiting_approval/ci, then the terminal set
 * completed/failed/cancelled/reverted/rejected/archived) — a copy of that
 * enum here would drift from the real CHECK constraint exactly the way
 * this repo's own VTID-03644 (five diverged language-name copies) and
 * VTID-03696 (a desynced workflow `paths:` list) already got burned once
 * each. Counting whatever status strings are actually present in the
 * input is both simpler and cannot go stale.
 */

export interface ExecutionStatusRecord {
  status: string;
  created_at: string;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Groups `records` by `status`, counting only those whose `created_at`
 * falls within `windowMs` (default 24h) before `nowMs` (default the
 * current time) and no later than `nowMs` itself. A record with a
 * malformed `status`/`created_at` is skipped rather than throwing.
 */
export function summarizeExecutionStatusCounts(
  records: ExecutionStatusRecord[],
  nowMs: number = Date.now(),
  windowMs: number = DEFAULT_WINDOW_MS,
): Record<string, number> {
  const cutoff = nowMs - windowMs;
  const counts: Record<string, number> = {};
  if (!Array.isArray(records)) return counts;

  for (const r of records) {
    if (!r || typeof r.status !== 'string' || r.status.length === 0) continue;
    if (typeof r.created_at !== 'string') continue;
    const t = Date.parse(r.created_at);
    if (Number.isNaN(t) || t < cutoff || t > nowMs) continue;
    counts[r.status] = (counts[r.status] || 0) + 1;
  }
  return counts;
}
