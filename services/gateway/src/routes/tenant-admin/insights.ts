/**
 * BOOTSTRAP-ADMIN-BB-CC: Admin insights endpoints.
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/insights
 *
 *   GET    /                     — list open + pending (default) insights
 *                                   ?status=open|pending_approval|...|all (default open+pending)
 *                                   ?domain=system_health|...  (filter)
 *                                   ?severity=urgent|action_needed|warning|info
 *                                   ?scanner=system_health
 *                                   ?limit=50 (default 50, max 200)
 *   GET    /:id                  — single insight (full context)
 *   POST   /:id/approve          — approve (status → approved)
 *   POST   /:id/reject           — reject (status → rejected)
 *   POST   /:id/snooze           — snooze (status → snoozed, optional ?hours=N)
 *   POST   /:id/dismiss          — dismiss (status → dismissed)
 *
 * The approve/reject/snooze/dismiss pattern mirrors routes/self-healing.ts
 * (approve/reject) so the autopilot executor (Phase FF) will pick up
 * status='approved' rows and dispatch them through the existing autopilot
 * event loop.
 */
import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';
import { emitOasisEvent } from '../../services/oasis-event-service';

const router = Router({ mergeParams: true });
const VTID = 'BOOTSTRAP-ADMIN-BB-CC';

const SEVERITY_ORDER = ['urgent', 'action_needed', 'warning', 'info'] as const;

function getTenantId(req: AuthenticatedRequest): string | null {
  return req.params.tenantId || ((req as any).targetTenantId as string | undefined) || null;
}

function getActorId(req: AuthenticatedRequest): string | null {
  return (req.identity?.user_id as string | undefined) ?? null;
}

router.get('/', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });

  const statusParam = typeof req.query.status === 'string' ? req.query.status : '';
  const domain = typeof req.query.domain === 'string' ? req.query.domain : null;
  const severity = typeof req.query.severity === 'string' ? req.query.severity : null;
  const scanner = typeof req.query.scanner === 'string' ? req.query.scanner : null;
  const limitRaw = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;

  let query = supabase
    .from('admin_insights')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('severity', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (statusParam === 'all') {
    // no status filter
  } else if (statusParam) {
    query = query.eq('status', statusParam);
  } else {
    query = query.in('status', ['open', 'pending_approval']);
  }
  if (domain) query = query.eq('domain', domain);
  if (severity) query = query.eq('severity', severity);
  if (scanner) query = query.eq('scanner', scanner);

  const { data, error } = await query;
  if (error) {
    console.warn(`[${VTID}] list failed: ${error.message}`);
    return res.status(500).json({ ok: false, error: error.message });
  }

  // Re-sort by severity desc (urgent → info) — Supabase's order on a CHECK
  // column is alphabetical, which doesn't match urgency. Do it client-side.
  const rows = (data ?? []).slice().sort((a: any, b: any) => {
    const ia = SEVERITY_ORDER.indexOf(a.severity);
    const ib = SEVERITY_ORDER.indexOf(b.severity);
    if (ia !== ib) return ia - ib;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return res.json({ ok: true, count: rows.length, insights: rows });
});

router.get('/:id', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });

  const { data, error } = await supabase
    .from('admin_insights')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  return res.json({ ok: true, insight: data });
});

async function resolveInsight(
  req: AuthenticatedRequest,
  res: Response,
  newStatus: 'approved' | 'rejected' | 'dismissed',
  resolvedVia: 'orb' | 'console' | 'autopilot' = 'console',
): Promise<Response> {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });
  const actorId = getActorId(req);

  const { data, error } = await supabase
    .from('admin_insights')
    .update({
      status: newStatus,
      resolved_at: new Date().toISOString(),
      resolved_by: actorId,
      resolved_via: resolvedVia,
    })
    .eq('tenant_id', tenantId)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    console.warn(`[${VTID}] ${newStatus} failed: ${error.message}`);
    return res.status(500).json({ ok: false, error: error.message });
  }
  if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  emitOasisEvent({
    vtid: VTID,
    type: `admin.insight.${newStatus}` as any,
    source: 'gateway',
    status: 'info',
    message: `Admin insight ${newStatus}: ${data.title}`,
    payload: {
      insight_id: data.id,
      tenant_id: tenantId,
      scanner: data.scanner,
      natural_key: data.natural_key,
      severity: data.severity,
      resolved_via: resolvedVia,
    },
    actor_id: actorId ?? undefined,
  }).catch(() => {});

  return res.json({ ok: true, insight: data });
}

router.post('/:id/approve', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) =>
  resolveInsight(req, res, 'approved'),
);

router.post('/:id/reject', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) =>
  resolveInsight(req, res, 'rejected'),
);

router.post('/:id/dismiss', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) =>
  resolveInsight(req, res, 'dismissed'),
);

router.post('/:id/snooze', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });
  const actorId = getActorId(req);

  const hoursRaw = Number(req.body?.hours ?? req.query?.hours ?? 24);
  const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(24 * 30, Math.floor(hoursRaw))) : 24;
  const snoozedUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('admin_insights')
    .update({
      status: 'snoozed',
      snoozed_until: snoozedUntil,
      resolved_by: actorId,
      resolved_via: 'console',
    })
    .eq('tenant_id', tenantId)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  emitOasisEvent({
    vtid: VTID,
    type: 'admin.insight.snoozed' as any,
    source: 'gateway',
    status: 'info',
    message: `Admin insight snoozed for ${hours}h: ${data.title}`,
    payload: { insight_id: data.id, tenant_id: tenantId, hours, snoozed_until: snoozedUntil },
    actor_id: actorId ?? undefined,
  }).catch(() => {});

  return res.json({ ok: true, insight: data, snoozed_until: snoozedUntil });
});

export default router;
