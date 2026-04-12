/**
 * Content Moderation API
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/content
 *
 * Endpoints:
 *   GET  /items                — List content items (filter by type, status)
 *   GET  /items/stats          — Counts by status + type
 *   GET  /items/:id            — Single item detail
 *   POST /items/:id/approve    — Approve item
 *   POST /items/:id/reject     — Reject item with reason
 *   POST /items/:id/flag       — Flag item for further review
 *   POST /items/:id/archive    — Archive an approved item
 */

import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router({ mergeParams: true });

// GET /items — list with filters
router.get('/items', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const status = (req.query.status as string || '').trim();
    const contentType = (req.query.type as string || '').trim();
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    let query = supabase
      .from('content_items')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('submitted_at', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('moderation_status', status);
    if (contentType) query = query.eq('content_type', contentType);

    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.json({ ok: true, items: data || [] });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /items/stats — counts by status and type
router.get('/items/stats', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;

    const { data, error } = await supabase
      .from('content_items')
      .select('moderation_status, content_type')
      .eq('tenant_id', tenantId);

    if (error) return res.status(500).json({ ok: false, error: error.message });

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    (data || []).forEach((item: any) => {
      byStatus[item.moderation_status] = (byStatus[item.moderation_status] || 0) + 1;
      byType[item.content_type] = (byType[item.content_type] || 0) + 1;
    });

    return res.json({
      ok: true,
      total: (data || []).length,
      by_status: byStatus,
      by_type: byType,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /items/:id — single item
router.get('/items/:id', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { data, error } = await supabase
      .from('content_items')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .single();

    if (error || !data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// POST /items/:id/approve
router.post('/items/:id/approve', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { data, error } = await supabase
      .from('content_items')
      .update({
        moderation_status: 'approved',
        moderated_by: req.identity!.user_id,
        moderated_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        moderation_note: req.body.note || null,
      })
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error || !data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// POST /items/:id/reject
router.post('/items/:id/reject', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { data, error } = await supabase
      .from('content_items')
      .update({
        moderation_status: 'rejected',
        moderated_by: req.identity!.user_id,
        moderated_at: new Date().toISOString(),
        moderation_note: req.body.reason || 'Rejected by admin',
      })
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error || !data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// POST /items/:id/flag
router.post('/items/:id/flag', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { data, error } = await supabase
      .from('content_items')
      .update({
        moderation_status: 'flagged',
        moderated_by: req.identity!.user_id,
        moderated_at: new Date().toISOString(),
        moderation_note: req.body.reason || 'Flagged for review',
      })
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error || !data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// POST /items/:id/archive
router.post('/items/:id/archive', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const tenantId = req.params.tenantId || (req as any).targetTenantId;
    const { data, error } = await supabase
      .from('content_items')
      .update({
        archived_at: new Date().toISOString(),
        moderation_note: req.body.reason || 'Archived by admin',
      })
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single();

    if (error || !data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
