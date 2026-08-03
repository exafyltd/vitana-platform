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
 *   DELETE /:id            — Delete a single notification
 *   DELETE /               — Delete all notifications for the user
 *                            (optional ?read_only=true to keep unread)
 *                            (optional ?category=<slug> to scope by type list)
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

  // ── Device takeover (VTID-03481) ──────────────────────────────────────────
  // An FCM token identifies a DEVICE INSTALLATION, not a (user, device) pair —
  // FCM hands the token to whoever registered last, so exactly one account can
  // own it at a time. This upsert's conflict target is (user_id, fcm_token),
  // which means a token re-registered by a DIFFERENT account used to INSERT a
  // second row instead of displacing the first. Combined with a sign-out that
  // never removed the row, every account that had ever signed in on a device
  // accumulated — and each one got its own copy of every fan-out notification,
  // rendered in ITS OWN locale. That is the "same notification twice, once in
  // German and once in English" bug: one phone, two accounts, two languages.
  //
  // So: revoke every OTHER account's claim on this device first, then take it.
  // Order matters — user_device_tokens_one_active_owner allows only one active
  // row per token, and doing this the other way round transiently violates it.
  const { error: revokeError } = await supabase
    .from('user_device_tokens')
    .update({ revoked_at: new Date().toISOString(), revoked_reason: 'taken_over' })
    .eq('fcm_token', fcm_token)
    .neq('user_id', identity.user_id)
    .is('revoked_at', null);

  if (revokeError) {
    // Don't take the device over on a half-applied state — the unique index
    // would reject the upsert anyway, and silently leaving the previous owner
    // active is exactly the duplicate-push bug.
    console.error('[Notifications] Device takeover failed:', revokeError);
    return res.status(500).json({ ok: false, error: revokeError.message });
  }

  const { error } = await supabase
    .from('user_device_tokens')
    .upsert(
      {
        user_id: identity.user_id,
        tenant_id: identity.tenant_id,
        fcm_token,
        device_label: device_label || null,
        updated_at: new Date().toISOString(),
        // Re-claim after a previous sign-out/takeover on this same device.
        revoked_at: null,
        revoked_reason: null,
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

  // Soft-revoke rather than DELETE (VTID-03481). The row is the only record
  // that this user was once signed in on this device; the Appilix suppression
  // in notification-service.ts needs it to tell "signed out on a device we
  // know about" (→ don't push, the device now belongs to someone else) apart
  // from "never registered a device token at all" (→ still needs the legacy
  // Appilix user_identity fallback, e.g. an iOS shell that never captured one).
  const supabase = getSupabase();
  await supabase
    .from('user_device_tokens')
    .update({ revoked_at: new Date().toISOString(), revoked_reason: 'signed_out' })
    .eq('user_id', identity.user_id)
    .eq('fcm_token', fcm_token)
    .is('revoked_at', null);

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

// ── DELETE /:id — Delete a single notification ─────────────

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  const { error } = await supabase
    .from('user_notifications')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', identity.user_id);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({ ok: true });
});

// ── DELETE / — Delete all (optionally scoped) ──────────────
//   ?read_only=true        delete only already-read notifications
//   ?types=a,b,c           delete only notifications whose `type` is in the list
//
// The two filters compose: pass both to delete read-only notifications
// for a specific category's types.

router.delete('/', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const readOnly = req.query.read_only === 'true' || req.query.read_only === '1';
  const typesRaw = typeof req.query.types === 'string' ? req.query.types : '';
  const types = typesRaw
    .split(',')
    .map((t: string) => t.trim())
    .filter(Boolean);

  const supabase = getSupabase();
  let query = supabase
    .from('user_notifications')
    .delete()
    .eq('user_id', identity.user_id)
    .eq('tenant_id', identity.tenant_id);

  if (readOnly) {
    query = query.not('read_at', 'is', null);
  }
  if (types.length > 0) {
    query = query.in('type', types);
  }

  const { error } = await query;

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({ ok: true });
});

export default router;
