/**
 * Community Admin API — admin-scoped reads of existing community data
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/community
 *
 * Reads from actual Supabase tables that community screens already write to:
 *   - community_meetups
 *   - community_groups
 *   - live_rooms + live_room_sessions
 *   - products_catalog / services_catalog (creators)
 *   - community_memberships
 */

import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router({ mergeParams: true });

// GET /meetups — community meetups/events
router.get('/meetups', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const { data, error } = await supabase
      .from('community_meetups')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('[COMMUNITY-ADMIN] community_meetups query error:', error.message);
      return res.json({ ok: true, meetups: [], error: error.message });
    }

    return res.json({ ok: true, meetups: data || [], count: (data || []).length });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /groups — community groups
router.get('/groups', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const { data, error } = await supabase
      .from('community_groups')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('[COMMUNITY-ADMIN] community_groups query error:', error.message);
      return res.json({ ok: true, groups: [], error: error.message });
    }

    return res.json({ ok: true, groups: data || [], count: (data || []).length });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /live-rooms — live rooms + session data
router.get('/live-rooms', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const { data, error } = await supabase
      .from('live_rooms')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('[COMMUNITY-ADMIN] live_rooms query error:', error.message);
      return res.json({ ok: true, rooms: [], error: error.message });
    }

    return res.json({ ok: true, rooms: data || [], count: (data || []).length });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /creators — creator/service profiles
router.get('/creators', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    // Try services_catalog first (creator services), then products_catalog
    const { data: services, error: sErr } = await supabase
      .from('services_catalog')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!sErr && services && services.length > 0) {
      return res.json({ ok: true, creators: services, count: services.length, source: 'services_catalog' });
    }

    const { data: products, error: pErr } = await supabase
      .from('products_catalog')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!pErr && products && products.length > 0) {
      return res.json({ ok: true, creators: products, count: products.length, source: 'products_catalog' });
    }

    return res.json({ ok: true, creators: [], count: 0 });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /memberships — community membership stats
router.get('/memberships', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const { data, error } = await supabase
      .from('community_memberships')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return res.json({ ok: true, memberships: [], error: error.message });
    }

    return res.json({ ok: true, memberships: data || [], count: (data || []).length });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /stats — overview stats across all community tables
router.get('/stats', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const [meetups, groups, rooms, memberships] = await Promise.all([
      supabase.from('community_meetups').select('id', { count: 'exact', head: true }),
      supabase.from('community_groups').select('id', { count: 'exact', head: true }),
      supabase.from('live_rooms').select('id', { count: 'exact', head: true }),
      supabase.from('community_memberships').select('id', { count: 'exact', head: true }),
    ]);

    return res.json({
      ok: true,
      stats: {
        meetups: meetups.count || 0,
        groups: groups.count || 0,
        live_rooms: rooms.count || 0,
        memberships: memberships.count || 0,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
