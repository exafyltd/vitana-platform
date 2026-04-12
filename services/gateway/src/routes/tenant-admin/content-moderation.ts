/**
 * Content Moderation API — queries existing media_uploads table
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/content
 *
 * The community screens write to `media_uploads` (with related
 * music_metadata, podcast_metadata, video_metadata tables).
 * Community screens filter by status='approved' + is_public=true.
 * Admin sees ALL items regardless of status — the moderation queue.
 *
 * Endpoints:
 *   GET  /items                — List all media uploads (filter by type, status)
 *   GET  /items/stats          — Counts by status + type
 *   GET  /items/:id            — Single item detail
 *   POST /items/:id/approve    — Set status=approved, is_public=true
 *   POST /items/:id/reject     — Set status=rejected, is_public=false
 *   POST /items/:id/flag       — Set status=flagged
 */

import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router({ mergeParams: true });

// GET /items — list media uploads (admin sees all statuses)
router.get('/items', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const status = (req.query.status as string || '').trim();
    const mediaType = (req.query.type as string || '').trim();
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    let query = supabase
      .from('media_uploads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);
    if (mediaType) query = query.eq('media_type', mediaType);

    const { data, error } = await query;

    if (error) {
      console.warn('[CONTENT-MOD] media_uploads query error:', error.message);
      return res.json({ ok: true, items: [], error: error.message });
    }

    return res.json({ ok: true, items: data || [], count: (data || []).length });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /items/stats — counts by status + type
router.get('/items/stats', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { data, error } = await supabase
      .from('media_uploads')
      .select('status, media_type');

    if (error) {
      return res.json({ ok: true, total: 0, by_status: {}, by_type: {} });
    }

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    (data || []).forEach((item: any) => {
      const s = item.status || 'unknown';
      const t = item.media_type || 'unknown';
      byStatus[s] = (byStatus[s] || 0) + 1;
      byType[t] = (byType[t] || 0) + 1;
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

// GET /items/:id — single item with metadata
router.get('/items/:id', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { data, error } = await supabase
      .from('media_uploads')
      .select('*, music_metadata(*), podcast_metadata(*), video_metadata(*)')
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// POST /items/:id/approve — mark as approved + public
router.post('/items/:id/approve', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { data, error } = await supabase
      .from('media_uploads')
      .update({
        status: 'approved',
        is_public: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error || !data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// POST /items/:id/reject — mark as rejected + not public
router.post('/items/:id/reject', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { data, error } = await supabase
      .from('media_uploads')
      .update({
        status: 'rejected',
        is_public: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error || !data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// POST /items/:id/flag — mark as flagged for review
router.post('/items/:id/flag', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { data, error } = await supabase
      .from('media_uploads')
      .update({
        status: 'flagged',
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error || !data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, item: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
