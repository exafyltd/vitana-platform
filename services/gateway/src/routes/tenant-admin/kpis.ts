/**
 * BOOTSTRAP-ADMIN-KPI-AA: Admin KPI endpoints.
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/kpis
 *
 *   GET  /           — current snapshot + 7-day history
 *   GET  /current    — current snapshot only (lighter payload)
 *   GET  /history    — historical daily snapshots (query ?days=30, default 7, max 90)
 *   POST /refresh    — force recompute this tenant (dev/admin convenience)
 *
 * Reads from tenant_kpi_current + tenant_kpi_daily. The worker
 * (services/admin-awareness-worker.ts) writes those tables every 5 min.
 */
import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { computeAndStoreForTenant } from '../../services/admin-awareness-worker';

const router = Router({ mergeParams: true });
const VTID = 'BOOTSTRAP-ADMIN-KPI-AA';

router.get('/', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

  const tenantId = req.params.tenantId || (req as any).targetTenantId;
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);

    const [currentResp, historyResp] = await Promise.all([
      supabase
        .from('tenant_kpi_current')
        .select('tenant_id, generated_at, kpi, computation_duration_ms, source_version')
        .eq('tenant_id', tenantId)
        .maybeSingle(),
      supabase
        .from('tenant_kpi_daily')
        .select('snapshot_date, kpi, computed_at')
        .eq('tenant_id', tenantId)
        .gte('snapshot_date', sevenDaysAgo)
        .order('snapshot_date', { ascending: false }),
    ]);

    if (currentResp.error) {
      console.warn(`[${VTID}] current query failed:`, currentResp.error.message);
      return res.status(500).json({ ok: false, error: currentResp.error.message });
    }
    if (historyResp.error) {
      console.warn(`[${VTID}] history query failed:`, historyResp.error.message);
    }

    return res.json({
      ok: true,
      tenant_id: tenantId,
      current: currentResp.data ?? null,
      history: historyResp.data ?? [],
      generated_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error(`[${VTID}] root GET error:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

router.get('/current', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = req.params.tenantId || (req as any).targetTenantId;
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });

  const { data, error } = await supabase
    .from('tenant_kpi_current')
    .select('tenant_id, generated_at, kpi, computation_duration_ms, source_version')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, current: data ?? null });
});

router.get('/history', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = req.params.tenantId || (req as any).targetTenantId;
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });

  const daysRaw = Number(req.query.days ?? 7);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(90, Math.floor(daysRaw))) : 7;
  const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('tenant_kpi_daily')
    .select('snapshot_date, kpi, computed_at')
    .eq('tenant_id', tenantId)
    .gte('snapshot_date', from)
    .order('snapshot_date', { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, days, history: data ?? [] });
});

router.post('/refresh', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.params.tenantId || (req as any).targetTenantId;
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });

  try {
    const start = Date.now();
    await computeAndStoreForTenant(tenantId);
    return res.json({ ok: true, tenant_id: tenantId, duration_ms: Date.now() - start });
  } catch (err: any) {
    console.error(`[${VTID}] refresh error:`, err.message);
    return res.status(500).json({ ok: false, error: err.message || 'REFRESH_FAILED' });
  }
});

export default router;
