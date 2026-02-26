/**
 * Admin Notifications API — Compose, Send & Track Notifications
 *
 * Endpoints:
 * - POST /compose       — Send notification to user(s) by ID, role, or all
 * - GET  /sent          — Admin-sent notification log (filtered, paginated)
 * - GET  /preferences/stats — Aggregate opt-in/out rates per category
 *
 * Security:
 * - All endpoints require Bearer token + exafy_admin
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { notifyUser, notifyUsersAsync, NotificationPayload } from '../services/notification-service';

const router = Router();
const VTID = 'ADMIN-NOTIFICATIONS';

// ── Auth Helper ─────────────────────────────────────────────

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

async function verifyExafyAdmin(
  req: Request
): Promise<{ ok: true; user_id: string; email: string } | { ok: false; status: number; error: string }> {
  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: 'UNAUTHENTICATED' };

  try {
    const userClient = createUserSupabaseClient(token);
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user) return { ok: false, status: 401, error: 'INVALID_TOKEN' };

    const appMetadata = authData.user.app_metadata || {};
    if (appMetadata.exafy_admin !== true) {
      return { ok: false, status: 403, error: 'FORBIDDEN' };
    }

    return { ok: true, user_id: authData.user.id, email: authData.user.email || 'unknown' };
  } catch (err: any) {
    console.error(`[${VTID}] Auth error:`, err.message);
    return { ok: false, status: 500, error: 'INTERNAL_ERROR' };
  }
}

// ── POST /compose — Send notification to user(s) ────────────

router.post('/compose', async (req: Request, res: Response) => {
  const authResult = await verifyExafyAdmin(req);
  if (!authResult.ok) return res.status(authResult.status).json({ ok: false, error: authResult.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const {
    recipient_ids,   // string[] — specific user IDs
    recipient_role,  // string — send to all users with this role (e.g. 'community', 'creator')
    tenant_id,       // string — required for role/all targeting
    send_to_all,     // boolean — send to ALL users in tenant
    type,            // string — notification type key (from TYPE_META)
    title,           // string — notification title
    body,            // string — notification body
    channel,         // string — override channel (push/inapp/push_and_inapp)
    priority,        // string — override priority (p0-p3)
    data,            // object — optional FCM data payload
  } = req.body;

  // Validate required fields
  if (!title || !body) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'title and body are required' });
  }
  if (!recipient_ids && !recipient_role && !send_to_all) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'Must specify recipient_ids, recipient_role, or send_to_all',
    });
  }

  const notificationType = type || 'welcome_to_vitana'; // fallback to system type
  const payload: NotificationPayload = {
    title,
    body,
    data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
  };

  try {
    let targetUserIds: string[] = [];

    if (recipient_ids && Array.isArray(recipient_ids) && recipient_ids.length > 0) {
      // Direct user IDs
      targetUserIds = recipient_ids;
    } else if (recipient_role && tenant_id) {
      // Fetch users by role in tenant
      const { data: members, error } = await supabase
        .from('user_tenants')
        .select('user_id')
        .eq('tenant_id', tenant_id)
        .eq('active_role', recipient_role);

      if (error) {
        console.error(`[${VTID}] POST /compose role lookup error:`, error.message);
        return res.status(500).json({ ok: false, error: error.message });
      }
      targetUserIds = (members || []).map((m: any) => m.user_id);
    } else if (send_to_all && tenant_id) {
      // Fetch all users in tenant
      const { data: members, error } = await supabase
        .from('user_tenants')
        .select('user_id')
        .eq('tenant_id', tenant_id);

      if (error) {
        console.error(`[${VTID}] POST /compose all-users lookup error:`, error.message);
        return res.status(500).json({ ok: false, error: error.message });
      }
      targetUserIds = (members || []).map((m: any) => m.user_id);
    }

    if (targetUserIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'NO_RECIPIENTS', message: 'No users matched the specified criteria' });
    }

    // Cap at 500 users per compose to prevent runaway
    if (targetUserIds.length > 500) {
      return res.status(400).json({
        ok: false,
        error: 'TOO_MANY_RECIPIENTS',
        message: `Found ${targetUserIds.length} users, max 500 per compose. Use filters to narrow.`,
      });
    }

    // Determine effective tenant_id for dispatching
    const effectiveTenantId = tenant_id || (recipient_ids?.length === 1 ? undefined : undefined);

    // For single recipients, use synchronous dispatch for immediate feedback
    if (targetUserIds.length === 1) {
      const result = await notifyUser(
        targetUserIds[0],
        effectiveTenantId || '',
        notificationType,
        payload,
        supabase
      );
      console.log(`[${VTID}] Composed notification for 1 user by ${authResult.email}: type=${notificationType}`);
      return res.json({ ok: true, sent_to: 1, result });
    }

    // For multiple recipients, use fire-and-forget
    notifyUsersAsync(
      targetUserIds,
      effectiveTenantId || '',
      notificationType,
      payload,
      supabase
    );

    console.log(`[${VTID}] Composed notification for ${targetUserIds.length} users by ${authResult.email}: type=${notificationType}`);

    return res.json({
      ok: true,
      sent_to: targetUserIds.length,
      message: `Dispatching ${notificationType} to ${targetUserIds.length} users`,
    });
  } catch (err: any) {
    console.error(`[${VTID}] POST /compose exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /sent — Admin notification log ──────────────────────

router.get('/sent', async (req: Request, res: Response) => {
  const authResult = await verifyExafyAdmin(req);
  if (!authResult.ok) return res.status(authResult.status).json({ ok: false, error: authResult.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { limit: limitStr, offset: offsetStr, type, user_id, days: daysStr, search } = req.query;
  const limit = Math.min(parseInt(limitStr as string) || 50, 200);
  const offset = parseInt(offsetStr as string) || 0;
  const days = parseInt(daysStr as string) || 30;

  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();

    let query = supabase
      .from('user_notifications')
      .select('*', { count: 'exact' })
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (type && typeof type === 'string') {
      query = query.eq('type', type);
    }
    if (user_id && typeof user_id === 'string') {
      query = query.eq('user_id', user_id);
    }
    if (search && typeof search === 'string') {
      query = query.or(`title.ilike.%${search}%,body.ilike.%${search}%`);
    }

    const { data, error, count } = await query;
    if (error) {
      console.error(`[${VTID}] GET /sent error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true, data: data || [], total: count || 0, limit, offset, days });
  } catch (err: any) {
    console.error(`[${VTID}] GET /sent exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /preferences/stats — Aggregate preference statistics ─

router.get('/preferences/stats', async (req: Request, res: Response) => {
  const authResult = await verifyExafyAdmin(req);
  if (!authResult.ok) return res.status(authResult.status).json({ ok: false, error: authResult.error });

  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });

  const { tenant_id } = req.query;

  try {
    // Get all preferences
    let query = supabase.from('user_notification_preferences').select('*');
    if (tenant_id && typeof tenant_id === 'string') {
      query = query.eq('tenant_id', tenant_id);
    }

    const { data: prefs, error } = await query;
    if (error) {
      console.error(`[${VTID}] GET /preferences/stats error:`, error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    const total = prefs?.length || 0;

    // Compute aggregate stats
    const stats = {
      total_users_with_prefs: total,
      push_enabled: prefs?.filter((p: any) => p.push_enabled !== false).length || 0,
      push_disabled: prefs?.filter((p: any) => p.push_enabled === false).length || 0,
      dnd_enabled: prefs?.filter((p: any) => p.dnd_enabled === true).length || 0,
      categories: {
        live_room_notifications: prefs?.filter((p: any) => p.live_room_notifications !== false).length || 0,
        match_notifications: prefs?.filter((p: any) => p.match_notifications !== false).length || 0,
        recommendation_notifications: prefs?.filter((p: any) => p.recommendation_notifications !== false).length || 0,
        task_notifications: prefs?.filter((p: any) => p.task_notifications !== false).length || 0,
        community_notifications: prefs?.filter((p: any) => p.community_notifications !== false).length || 0,
        memory_notifications: prefs?.filter((p: any) => p.memory_notifications !== false).length || 0,
      },
    };

    // Get total notification count (last 30 days)
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { count: notificationCount } = await supabase
      .from('user_notifications')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since);

    const { count: readCount } = await supabase
      .from('user_notifications')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since)
      .not('read_at', 'is', null);

    return res.json({
      ok: true,
      stats,
      delivery: {
        total_sent_30d: notificationCount || 0,
        total_read_30d: readCount || 0,
        read_rate: notificationCount ? Math.round(((readCount || 0) / notificationCount) * 100) : 0,
      },
    });
  } catch (err: any) {
    console.error(`[${VTID}] GET /preferences/stats exception:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
