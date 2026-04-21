/**
 * BOOTSTRAP-ADMIN-GG: Tenant Health Index endpoints.
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/health-index
 *
 *   GET  /           — current score + 30-day history trend
 *   GET  /current    — latest score only
 *   POST /refresh    — recompute on-demand (admin-facing convenience)
 *
 * Reads from tenant_health_index_daily. Writes happen via the admin
 * awareness worker (storeTenantHealthIndex).
 */
import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { storeTenantHealthIndex } from '../../services/admin-health-index';

const router = Router({ mergeParams: true });
const VTID = 'BOOTSTRAP-ADMIN-GG';

router.get('/', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = req.params.tenantId || (req as any).targetTenantId;
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });

  const daysParam = Number.parseInt((req.query.days as string) || '30', 10);
  const days = Number.isFinite(daysParam) ? Math.max(7, Math.min(90, daysParam)) : 30;
  const startDate = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  try {
    const { data, error } = await supabase
      .from('tenant_health_index_daily')
      .select('snapshot_date, score, components, computed_at, source_version')
      .eq('tenant_id', tenantId)
      .gte('snapshot_date', startDate)
      .order('snapshot_date', { ascending: false });
    if (error) {
      console.warn(`[${VTID}] history query failed: ${error.message}`);
      return res.status(500).json({ ok: false, error: error.message });
    }

    const rows = data ?? [];
    const current = rows[0] ?? null;
    // Compute trend: mean of last 7 minus mean of previous 7
    const last7 = rows.slice(0, 7);
    const prev7 = rows.slice(7, 14);
    const mean = (a: typeof rows) => (a.length ? Math.round(a.reduce((s, r) => s + r.score, 0) / a.length) : null);
    const last7Mean = mean(last7);
    const prev7Mean = mean(prev7);
    const weekly_delta = last7Mean !== null && prev7Mean !== null ? last7Mean - prev7Mean : null;

    return res.json({
      ok: true,
      tenant_id: tenantId,
      current,
      history: rows,
      summary: {
        last7_mean: last7Mean,
        prior7_mean: prev7Mean,
        weekly_delta,
        days_of_data: rows.length,
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn(`[${VTID}] fetch failed: ${err?.message}`);
    return res.status(500).json({ ok: false, error: err?.message || 'UNKNOWN' });
  }
});

router.get('/current', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = req.params.tenantId || (req as any).targetTenantId;
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });

  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data } = await supabase
      .from('tenant_health_index_daily')
      .select('snapshot_date, score, components, computed_at, source_version')
      .eq('tenant_id', tenantId)
      .lte('snapshot_date', today)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    return res.json({ ok: true, tenant_id: tenantId, current: data ?? null });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || 'UNKNOWN' });
  }
});

router.post('/refresh', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.params.tenantId || (req as any).targetTenantId;
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });
  try {
    const result = await storeTenantHealthIndex(tenantId);
    if (!result) return res.status(500).json({ ok: false, error: 'HEALTH_INDEX_COMPUTE_FAILED' });
    return res.json({ ok: true, tenant_id: tenantId, ...result });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || 'UNKNOWN' });
  }
});

export default router;
