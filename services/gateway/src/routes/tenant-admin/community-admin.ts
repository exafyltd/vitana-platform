/**
 * Community Admin API — admin-scoped reads of community data
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/community
 *
 * Reads existing community tables (events, groups, live rooms) scoped to tenant.
 * No new tables — piggybacks on what the community screens already write to.
 */

import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router({ mergeParams: true });

// GET /meetups — list community events/meetups
router.get('/meetups', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    // Try common event table names
    for (const table of ['events', 'meetups', 'community_events']) {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (!error && data) {
        return res.json({ ok: true, meetups: data, source_table: table });
      }
    }

    return res.json({ ok: true, meetups: [], message: 'No events table found' });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /groups — list community groups
router.get('/groups', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    for (const table of ['groups', 'community_groups', 'chat_groups']) {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (!error && data) {
        return res.json({ ok: true, groups: data, source_table: table });
      }
    }

    return res.json({ ok: true, groups: [], message: 'No groups table found' });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /live-rooms — list live rooms
router.get('/live-rooms', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    for (const table of ['live_rooms', 'rooms', 'daily_rooms']) {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (!error && data) {
        return res.json({ ok: true, rooms: data, source_table: table });
      }
    }

    return res.json({ ok: true, rooms: [], message: 'No live rooms table found' });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// GET /creators — list creators
router.get('/creators', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    for (const table of ['creator_profiles', 'creators', 'reseller_profiles']) {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (!error && data) {
        return res.json({ ok: true, creators: data, source_table: table });
      }
    }

    return res.json({ ok: true, creators: [], message: 'No creators table found' });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
