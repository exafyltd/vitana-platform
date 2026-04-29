/**
 * VTID-02601 — Reminders REST API
 *
 * Mounted at: /api/v1/reminders
 *
 * Endpoints:
 *   POST   /api/v1/reminders                  Create
 *   GET    /api/v1/reminders                  List (?status, ?include_fired, ?q, ?limit)
 *   GET    /api/v1/reminders/missed           Fired but not acked
 *   GET    /api/v1/reminders/:id              Get one
 *   PATCH  /api/v1/reminders/:id              Edit
 *   POST   /api/v1/reminders/:id/snooze       Push next_fire_at by N minutes
 *   POST   /api/v1/reminders/:id/ack          Mark delivered (records delivery_via)
 *   POST   /api/v1/reminders/:id/complete     Mark completed (user did the thing)
 *   DELETE /api/v1/reminders/:id              Soft-cancel (status='cancelled')
 *   DELETE /api/v1/reminders?mode=all         Soft-cancel all active reminders
 *
 * SSE stream and audio delivery wiring lands in PR-2.
 */

import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import {
  createReminder,
  softDeleteReminders,
  findReminders,
  formatTimeForVoice,
  ReminderValidationError,
} from '../services/reminders-service';

const router = Router();
const LOG_PREFIX = '[Reminders]';

function getUserId(req: Request): string | null {
  // @ts-ignore
  if (req.user?.id) return req.user.id;
  // @ts-ignore
  if (req.user?.sub) return req.user.sub;
  return req.get('X-User-ID') || req.get('X-Vitana-User') || (req.query.user_id as string) || null;
}

function getTenantId(req: Request): string {
  // @ts-ignore
  if (req.user?.tenant_id) return req.user.tenant_id;
  return (
    req.get('X-Tenant-ID') ||
    req.get('X-Vitana-Tenant') ||
    process.env.DEFAULT_TENANT_ID ||
    '00000000-0000-0000-0000-000000000000'
  );
}

function getUserTz(req: Request): string {
  return (
    (req.body?.user_tz as string) ||
    (req.query.tz as string) ||
    req.get('X-Vitana-Timezone') ||
    'UTC'
  );
}

function getLang(req: Request): string {
  return (
    (req.body?.lang as string) ||
    (req.query.lang as string) ||
    req.get('X-Vitana-Lang') ||
    'en'
  );
}

// =============================================================================
// POST /reminders — create
// =============================================================================
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const admin = getSupabase();
    if (!admin) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    const { action_text, spoken_message, scheduled_for_iso, description, calendar_event_id } = req.body || {};
    const reminder = await createReminder(admin, {
      user_id: userId,
      tenant_id: getTenantId(req),
      action_text,
      spoken_message: spoken_message || action_text,
      scheduled_for_iso,
      user_tz: getUserTz(req),
      lang: getLang(req),
      description,
      calendar_event_id: calendar_event_id || null,
      created_via: 'ui',
    });
    return res.status(201).json({ ok: true, data: reminder });
  } catch (err: any) {
    if (err instanceof ReminderValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error(`${LOG_PREFIX} POST / error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// GET /reminders — list
// =============================================================================
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const admin = getSupabase();
    if (!admin) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    const includeFired = req.query.include_fired === '1' || req.query.include_fired === 'true';
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10) || 50, 200);
    const q = (req.query.q as string) || undefined;

    const data = await findReminders(admin, userId, {
      query: q,
      include_fired: includeFired,
      limit,
    });
    return res.json({ ok: true, data, count: data.length });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET / error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// GET /reminders/missed — fired but not acked (for catch-up banner)
// =============================================================================
router.get('/missed', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const admin = getSupabase();
    if (!admin) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    const { data, error } = await admin
      .from('reminders')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'fired')
      .is('acked_at', null)
      .order('fired_at', { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);

    return res.json({ ok: true, data: data || [], count: data?.length || 0 });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /missed error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// GET /reminders/:id
// =============================================================================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const admin = getSupabase();
    if (!admin) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    const { data, error } = await admin
      .from('reminders')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, data });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /:id error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// PATCH /reminders/:id — edit (action_text, spoken_message, next_fire_at, description)
// =============================================================================
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const admin = getSupabase();
    if (!admin) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    const updates: Record<string, unknown> = {};
    if (typeof req.body?.action_text === 'string') updates.action_text = req.body.action_text.trim();
    if (typeof req.body?.spoken_message === 'string') updates.spoken_message = req.body.spoken_message.trim();
    if (typeof req.body?.description === 'string') updates.description = req.body.description;
    if (typeof req.body?.scheduled_for_iso === 'string') {
      const t = new Date(req.body.scheduled_for_iso);
      if (isNaN(t.getTime())) return res.status(400).json({ ok: false, error: 'invalid scheduled_for_iso' });
      if (t.getTime() < Date.now() + 60_000) {
        return res.status(400).json({ ok: false, error: 'Time must be at least 60 seconds in the future' });
      }
      updates.next_fire_at = t.toISOString();
      updates.status = 'pending';
      updates.fired_at = null;
      updates.acked_at = null;
      updates.delivery_via = null;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: 'no updatable fields supplied' });
    }

    const { data, error } = await admin
      .from('reminders')
      .update(updates)
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, data });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} PATCH /:id error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// POST /reminders/:id/snooze — push by N minutes (default 10)
// =============================================================================
router.post('/:id/snooze', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const admin = getSupabase();
    if (!admin) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    const minutes = Math.max(1, Math.min(parseInt(String(req.body?.minutes ?? '10'), 10) || 10, 24 * 60));
    const newTime = new Date(Date.now() + minutes * 60_000).toISOString();

    const { data: row } = await admin
      .from('reminders')
      .select('snooze_count')
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .maybeSingle();
    if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

    const { data, error } = await admin
      .from('reminders')
      .update({
        next_fire_at: newTime,
        status: 'pending',
        fired_at: null,
        acked_at: null,
        delivery_via: null,
        snooze_count: ((row as any).snooze_count || 0) + 1,
      })
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return res.json({ ok: true, data });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /:id/snooze error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// POST /reminders/:id/ack — record delivery
// =============================================================================
router.post('/:id/ack', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const admin = getSupabase();
    if (!admin) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    const via = String(req.body?.via || 'manual');
    if (!['sse', 'fcm', 'manual', 'manual_replay', 'none'].includes(via)) {
      return res.status(400).json({ ok: false, error: 'invalid via' });
    }

    const { data, error } = await admin
      .from('reminders')
      .update({ acked_at: new Date().toISOString(), delivery_via: via })
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .select('id, acked_at, delivery_via')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, data });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /:id/ack error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// POST /reminders/:id/complete — user did the thing
// =============================================================================
router.post('/:id/complete', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const admin = getSupabase();
    if (!admin) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    const { data, error } = await admin
      .from('reminders')
      .update({
        status: 'completed',
        acked_at: new Date().toISOString(),
        delivery_via: 'manual',
      })
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, data });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /:id/complete error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// DELETE /reminders/:id — soft-cancel one
// DELETE /reminders?mode=all — soft-cancel all active reminders
// =============================================================================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const admin = getSupabase();
    if (!admin) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    const result = await softDeleteReminders(
      admin,
      userId,
      { mode: 'single', reminder_id: req.params.id },
      'ui',
    );
    if (result.deleted === 0) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.json({ ok: true, deleted: result.deleted, action_text: result.action_text });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} DELETE /:id error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

router.delete('/', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const admin = getSupabase();
    if (!admin) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    const mode = (req.query.mode as string) || '';
    if (mode !== 'all') {
      return res.status(400).json({ ok: false, error: 'mode=all required for collection delete' });
    }
    const result = await softDeleteReminders(admin, userId, { mode: 'all' }, 'ui');
    return res.json({ ok: true, deleted: result.deleted });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} DELETE / error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// GET /reminders/health — service health
// =============================================================================
router.get('/_health/check', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'reminders', vtid: 'VTID-02601' });
});

// Helper exposed for ad-hoc curl debugging during PR-1 verification.
// Not used by frontend.
router.get('/_format-time-debug', (req: Request, res: Response) => {
  const tz = (req.query.tz as string) || 'UTC';
  const locale = (req.query.locale as string) || 'en';
  const iso = (req.query.iso as string) || new Date().toISOString();
  res.json({ formatted: formatTimeForVoice(new Date(iso), tz, locale) });
});

export default router;
