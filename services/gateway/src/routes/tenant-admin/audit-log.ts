/**
 * Audit & Compliance section: Tenant Admin Audit Log API
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/audit
 *
 * Endpoints:
 *   GET /actions   — Admin action audit trail (grants, revokes, invites, settings changes)
 *   GET /access    — Access log (login events for tenant members)
 */

import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router({ mergeParams: true });

// GET /actions — admin action audit trail
router.get('/actions', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const action = (req.query.action as string || '').trim();

    let query = supabase
      .from('tenant_admin_audit_log')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (action) query = query.eq('action', action);

    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.json({ ok: true, actions: data || [] });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /access — access log (tenant-scoped OASIS auth events)
router.get('/access', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    // Query OASIS events for auth-related topics
    const { data, error } = await supabase
      .from('oasis_events')
      .select('*')
      .in('topic', ['auth.login', 'auth.logout', 'auth.signup', 'role.changed'])
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.json({ ok: true, access_log: data || [] });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
