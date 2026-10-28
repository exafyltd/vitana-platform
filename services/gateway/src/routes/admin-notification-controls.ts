/**
 * VTID-04674: Admin › Notifications — the on/off switch per notification type.
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/notification-controls
 *
 *   GET    /                ?days=7   every type (catalog + seen in the DB), its switch,
 *                                     who receives it, its member category and 7-day counts
 *   PATCH  /:type            { enabled, reason?, source_key? }   switch a type, or one
 *                                     automation's sends of it, on or off
 *   GET    /:type/audit               who switched it and when
 *   GET    /activity        ?days=30  per-day, per-type sent/pushed/read/blocked
 *
 * Access: tenant admin of :tenantId, or exafy_admin (requireTenantAdmin).
 * A counter that cannot be read comes back as an error, never as 0.
 */

import { Router, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import type { AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { requireTenantAdmin } from '../middleware/require-tenant-admin';
import {
  listNotificationControls,
  setNotificationControl,
  getNotificationControlAudit,
  getNotificationActivity,
  NotificationControlError,
} from '../services/notification-controls/notification-controls-service';

const router = Router({ mergeParams: true });

router.use(requireTenantAdmin);

function tenantOf(req: AuthenticatedRequest): string {
  return String(req.params.tenantId || '');
}

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });
  try {
    const days = intParam(req.query.days, 7, 1, 90);
    const result = await listNotificationControls(sb, tenantOf(req), days);
    return res.json({ ok: true, days, ...result });
  } catch (err: any) {
    console.error('[admin-notification-controls] list failed:', err?.message);
    return res.status(500).json({ ok: false, error: 'LIST_FAILED', message: err?.message });
  }
});

router.get('/activity', async (req: AuthenticatedRequest, res: Response) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });
  try {
    const days = intParam(req.query.days, 30, 1, 90);
    const rows = await getNotificationActivity(sb, tenantOf(req), days);
    return res.json({ ok: true, days, rows });
  } catch (err: any) {
    console.error('[admin-notification-controls] activity failed:', err?.message);
    return res.status(500).json({ ok: false, error: 'ACTIVITY_FAILED', message: err?.message });
  }
});

router.get('/:type/audit', async (req: AuthenticatedRequest, res: Response) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });
  try {
    const rows = await getNotificationControlAudit(sb, tenantOf(req), String(req.params.type), intParam(req.query.limit, 50, 1, 200));
    return res.json({ ok: true, rows });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: 'AUDIT_FAILED', message: err?.message });
  }
});

// impact-allow-no-oasis: setNotificationControl() emits notification.control.changed
// and writes the audit row for every switch.
router.patch('/:type', async (req: AuthenticatedRequest, res: Response) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });
  const body = req.body || {};
  try {
    const result = await setNotificationControl(sb, {
      tenantId: tenantOf(req),
      type: String(req.params.type),
      sourceKey: body.source_key,
      enabled: body.enabled,
      reason: body.reason,
      actorUserId: req.identity?.user_id ?? null,
      actorEmail: req.identity?.email ?? null,
    });
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    if (err instanceof NotificationControlError) {
      const status = err.code === 'invalid_input' ? 400 : err.code === 'not_localized' ? 409 : 500;
      return res.status(status).json({ ok: false, error: err.code.toUpperCase(), message: err.message });
    }
    console.error('[admin-notification-controls] update failed:', err?.message);
    return res.status(500).json({ ok: false, error: 'UPDATE_FAILED', message: err?.message });
  }
});

export default router;
