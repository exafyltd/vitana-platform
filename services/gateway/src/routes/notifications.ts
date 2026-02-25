/**
 * Notification API Routes
 *
 * Endpoints:
 *   POST   /token          — Register FCM device token
 *   DELETE /token          — Remove FCM device token (logout)
 *   GET    /               — Notification history (paginated)
 *   GET    /unread-count   — Unread badge count
 *   POST   /:id/read       — Mark notification as read
 *   POST   /mark-all-read  — Mark all notifications as read
 */

import { Router, Request, Response } from 'express';
import {
  requireAuth,
  requireTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { createClient } from '@supabase/supabase-js';

const router = Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE!
  );
}

// ── POST /token — Register FCM device token ────────────────

router.post('/token', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { fcm_token, device_label } = req.body;
  if (!fcm_token || typeof fcm_token !== 'string') {
    return res.status(400).json({ ok: false, error: 'fcm_token is required' });
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from('user_device_tokens')
    .upsert(
      {
        user_id: identity.user_id,
        tenant_id: identity.tenant_id,
        fcm_token,
        device_label: device_label || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,fcm_token' }
    );

  if (error) {
    console.error('[Notifications] Token upsert error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({ ok: true });
});

// ── DELETE /token — Remove FCM device token ────────────────

router.delete('/token', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { fcm_token } = req.body;
  if (!fcm_token) {
    return res.status(400).json({ ok: false, error: 'fcm_token is required' });
  }

  const supabase = getSupabase();
  await supabase
    .from('user_device_tokens')
    .delete()
    .eq('user_id', identity.user_id)
    .eq('fcm_token', fcm_token);

  res.json({ ok: true });
});

// ── GET / — Notification history (paginated) ───────────────

router.get('/', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('user_notifications')
    .select('*')
    .eq('user_id', identity.user_id)
    .eq('tenant_id', identity.tenant_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({ ok: true, data });
});

// ── GET /unread-count — Badge count ────────────────────────

router.get('/unread-count', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('user_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', identity.user_id)
    .eq('tenant_id', identity.tenant_id)
    .is('read_at', null);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({ ok: true, count: count || 0 });
});

// ── POST /:id/read — Mark single notification as read ──────

router.post('/:id/read', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  const { error } = await supabase
    .from('user_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', identity.user_id);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({ ok: true });
});

// ── POST /mark-all-read — Mark all as read ─────────────────

router.post('/mark-all-read', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  const { error } = await supabase
    .from('user_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', identity.user_id)
    .eq('tenant_id', identity.tenant_id)
    .is('read_at', null);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({ ok: true });
});

export default router;
