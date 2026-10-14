/**
 * VTID-05163 (Health Hub Phase 1 / B3) — the Vitana Index dual-compute report
 * (plan Change 12). exafy_admin only, read only, AGGREGATES ONLY: member-days
 * compared, % with Δtotal = 0, p50/p95/max |Δtotal|, member-days per diff
 * class, row-set mismatches per key class, job failures, the consent_withheld
 * impact (members and points, as numbers), the Stage 1 / Stage 2 verdict, and
 * B2's per-writer dual-write failure counters. No member id and no health
 * value ever leaves this route.
 *
 * Mounted at /api/v1/admin/health/index-dual-compute.
 *   GET /report?from=YYYY-MM-DD&to=YYYY-MM-DD&scope=device|all
 *     from/to default to the last 14 days; scope defaults to `device`.
 *     503 DUAL_COMPUTE_STORE_PENDING while the Aurora-only table is absent.
 */
import { Router, Response } from 'express';
import { requireAuth, requireExafyAdmin, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { addDays, defaultDualComputeDeps, loadDualComputeReport } from '../services/health-features/index-dual-compute';

const router = Router();
router.use(requireAuth, requireExafyAdmin);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

function isDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
}

router.get('/report', async (req: AuthenticatedRequest, res: Response) => {
  const today = new Date().toISOString().slice(0, 10);
  const to = req.query.to === undefined ? today : req.query.to;
  const from = req.query.from === undefined ? addDays(typeof to === 'string' && isDate(to) ? to : today, -13) : req.query.from;
  const scope = req.query.scope === undefined ? 'device' : req.query.scope;
  if (!isDate(from) || !isDate(to) || from > to) {
    return res.status(400).json({ ok: false, error: 'INVALID_RANGE', message: 'from/to must be YYYY-MM-DD with from <= to' });
  }
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > MAX_RANGE_DAYS * 86_400_000) {
    return res.status(400).json({ ok: false, error: 'RANGE_TOO_LONG', message: `at most ${MAX_RANGE_DAYS} days` });
  }
  if (scope !== 'device' && scope !== 'all') {
    return res.status(400).json({ ok: false, error: 'INVALID_SCOPE', message: 'scope must be device or all' });
  }
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const result = await loadDualComputeReport(defaultDualComputeDeps(sb), { from, to, scope });
  if (!result.ok) return res.status(503).json({ ok: false, error: result.code });
  return res.status(200).json(result);
});

export default router;
