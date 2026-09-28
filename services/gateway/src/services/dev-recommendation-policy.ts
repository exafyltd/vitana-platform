/**
 * VTID-04666: shared rules for developer-side autopilot recommendations
 * (dev_autopilot scanner findings and dev_autopilot_impact findings).
 *
 *  - A fingerprint a human rejected stays blocked for REJECTED_FINGERPRINT_BLOCK_DAYS
 *    — the dedupe used to look only at new/snoozed/activated rows, so a
 *    rejected signal came back on the next scan.
 *  - Every developer finding gets an expiry. A finding the scanner keeps
 *    seeing has its expiry pushed forward on each sighting; one it stops
 *    seeing expires and leaves the lists.
 *  - Pending approvals sort by an explicit risk rank. PostgREST sorted
 *    risk_class as text (medium > low > high), so high risk came last.
 */

export const REJECTED_FINGERPRINT_BLOCK_DAYS = 30;
export const DEV_RECOMMENDATION_EXPIRY_DAYS = 30;

const DAY_MS = 86400000;

/** ISO timestamp: rows rejected at or after this are still blocking. */
export function rejectedBlockSinceIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - REJECTED_FINGERPRINT_BLOCK_DAYS * DAY_MS).toISOString();
}

/** ISO timestamp a developer finding written or seen now expires at. */
export function devRecommendationExpiresAtIso(nowMs: number = Date.now()): string {
  return new Date(nowMs + DEV_RECOMMENDATION_EXPIRY_DAYS * DAY_MS).toISOString();
}

/**
 * PostgREST path listing the fingerprints of one source rejected within the
 * block window. One query per ingest run, not one per signal.
 */
export function recentlyRejectedFingerprintsPath(sourceType: string, nowMs: number = Date.now()): string {
  return (
    `/rest/v1/autopilot_recommendations?source_type=eq.${sourceType}` +
    `&status=eq.rejected&updated_at=gte.${rejectedBlockSinceIso(nowMs)}` +
    `&signal_fingerprint=not.is.null&select=signal_fingerprint&limit=10000`
  );
}

/** Collects the fingerprint set from the rows the path above returns. */
export function toFingerprintSet(rows: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const fp = (r as { signal_fingerprint?: unknown } | null)?.signal_fingerprint;
    if (typeof fp === 'string' && fp) out.add(fp);
  }
  return out;
}

/** Explicit risk order for the approval inbox: high first. */
export const RISK_RANK: Readonly<Record<string, number>> = { critical: 4, high: 3, medium: 2, low: 1 };

function riskRank(v: unknown): number {
  return typeof v === 'string' ? RISK_RANK[v.toLowerCase()] ?? 0 : 0;
}

/** Missing / non-numeric impact sorts below every real score (scores are >= 0). */
function impact(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : -1;
}

/** Missing / unparseable timestamps sort last. */
function timeMs(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pending-approvals order: risk rank (critical > high > medium > low > unset),
 * then impact_score desc, then created_at desc; stable otherwise. Returns a
 * new array.
 */
export function comparePendingApprovals(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return (
    riskRank(b.risk_class) - riskRank(a.risk_class) ||
    impact(b.impact_score) - impact(a.impact_score) ||
    timeMs(b.created_at) - timeMs(a.created_at)
  );
}

export function sortPendingApprovals<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => comparePendingApprovals(a.row, b.row) || a.i - b.i)
    .map((x) => x.row);
}
