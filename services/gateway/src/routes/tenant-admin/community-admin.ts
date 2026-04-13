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

// GET /meetups — community events from global_community_events
// Includes organizer profile + ticket pricing from related tables
router.get('/meetups', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);

    // Get events sorted by start_time (next upcoming first)
    const { data: events, error } = await supabase
      .from('global_community_events')
      .select('*')
      .order('start_time', { ascending: true })
      .limit(limit);

    if (error) {
      console.warn('[COMMUNITY-ADMIN] global_community_events query error:', error.message);
      return res.json({ ok: true, meetups: [], error: error.message });
    }

    if (!events || events.length === 0) {
      return res.json({ ok: true, meetups: [], count: 0 });
    }

    // Get organizer profiles
    const organizerIds = [...new Set(events.map((e: any) => e.created_by).filter(Boolean))];
    const { data: profiles } = await supabase
      .from('app_users')
      .select('user_id, email, display_name, avatar_url')
      .in('user_id', organizerIds);

    const profileMap: Record<string, any> = {};
    (profiles || []).forEach((p: any) => { profileMap[p.user_id] = p; });

    // Get ticket info per event
    const eventIds = events.map((e: any) => e.id);
    const { data: tickets } = await supabase
      .from('event_ticket_types')
      .select('event_id, name, price, currency, quantity_available, quantity_sold')
      .in('event_id', eventIds);

    const ticketMap: Record<string, any[]> = {};
    (tickets || []).forEach((t: any) => {
      if (!ticketMap[t.event_id]) ticketMap[t.event_id] = [];
      ticketMap[t.event_id].push(t);
    });

    // Enrich events
    const enriched = events.map((e: any) => ({
      ...e,
      organizer: profileMap[e.created_by] || { display_name: 'Unknown', email: null },
      tickets: ticketMap[e.id] || [],
      price: ticketMap[e.id]?.[0]?.price ?? null,
      currency: ticketMap[e.id]?.[0]?.currency ?? 'EUR',
    }));

    return res.json({ ok: true, meetups: enriched, count: enriched.length });
  } catch (err: any) {
    console.error('[COMMUNITY-ADMIN] meetups error:', err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// DELETE /meetups/:id — delete an event
router.delete('/meetups/:id', requireTenantAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });

    const { error } = await supabase
      .from('global_community_events')
      .delete()
      .eq('id', req.params.id);

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true });
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
      .from('global_community_groups')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('[COMMUNITY-ADMIN] global_community_groups query error:', error.message);
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

    const { data, error } = await supabase
      .from('creator_profiles')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('[COMMUNITY-ADMIN] creator_profiles query error:', error.message);
      return res.json({ ok: true, creators: [], error: error.message });
    }

    return res.json({ ok: true, creators: data || [], count: (data || []).length });
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
      supabase.from('global_community_events').select('id', { count: 'exact', head: true }),
      supabase.from('global_community_groups').select('id', { count: 'exact', head: true }),
      supabase.from('live_rooms').select('id', { count: 'exact', head: true }),
      supabase.from('global_community_group_members').select('id', { count: 'exact', head: true }),
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
