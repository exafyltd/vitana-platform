/**
 * Scheduled Notification Webhook Endpoints
 *
 * Cloud Scheduler (or manual cron) triggers these endpoints to dispatch
 * time-based notifications to all active users in a tenant.
 *
 * Endpoints:
 *   POST /api/v1/scheduled-notifications/morning-briefing
 *   POST /api/v1/scheduled-notifications/diary-reminder
 *   POST /api/v1/scheduled-notifications/weekly-digest
 *   POST /api/v1/scheduled-notifications/weekly-summary
 *   POST /api/v1/scheduled-notifications/weekly-reflection
 *   POST /api/v1/scheduled-notifications/meetup-reminders
 *   POST /api/v1/scheduled-notifications/recommendation-expiry
 *   POST /api/v1/scheduled-notifications/signal-cleanup
 */

import { Router, Request, Response } from 'express';
import { notifyUserAsync } from '../services/notification-service';

const router = Router();

// ── Helper: get service-role Supabase client ─────────────────
async function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

// ── Helper: get all active users for a tenant ────────────────
async function getActiveUsers(supabase: any, tenantId: string): Promise<Array<{ user_id: string }>> {
  const { data } = await supabase
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('is_primary', true);
  return data || [];
}

// ── Helper: extract tenant_id from body or use default ───────
function getTenantId(req: Request): string | null {
  return req.body?.tenant_id || process.env.DEFAULT_TENANT_ID || null;
}

// =============================================================================
// POST /morning-briefing — Daily 7 AM UTC
// =============================================================================
router.post('/morning-briefing', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;

  for (const { user_id } of users) {
    notifyUserAsync(user_id, tenantId, 'morning_briefing_ready', {
      title: 'Good Morning!',
      body: 'Your daily briefing is ready. See what\'s happening today.',
      data: { url: '/dashboard' },
    }, supa);
    dispatched++;
  }

  console.log(`[Scheduled] morning_briefing_ready → ${dispatched} users`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /diary-reminder — Daily 9 PM UTC
// =============================================================================
router.post('/diary-reminder', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;

  for (const { user_id } of users) {
    notifyUserAsync(user_id, tenantId, 'daily_diary_reminder', {
      title: 'Diary Reminder',
      body: 'Take a moment to reflect on your day.',
      data: { url: '/diary' },
    }, supa);
    dispatched++;
  }

  console.log(`[Scheduled] daily_diary_reminder → ${dispatched} users`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /weekly-digest — Sunday 6 PM UTC
// =============================================================================
router.post('/weekly-digest', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;

  for (const { user_id } of users) {
    notifyUserAsync(user_id, tenantId, 'weekly_community_digest', {
      title: 'Weekly Community Digest',
      body: 'See what happened in your community this week.',
      data: { url: '/community' },
    }, supa);
    dispatched++;
  }

  console.log(`[Scheduled] weekly_community_digest → ${dispatched} users`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /weekly-summary — Sunday 8 AM UTC
// =============================================================================
router.post('/weekly-summary', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;

  for (const { user_id } of users) {
    notifyUserAsync(user_id, tenantId, 'weekly_activity_summary', {
      title: 'Your Weekly Summary',
      body: 'Here\'s a snapshot of your activity and progress this week.',
      data: { url: '/dashboard' },
    }, supa);
    dispatched++;
  }

  console.log(`[Scheduled] weekly_activity_summary → ${dispatched} users`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /weekly-reflection — Friday 8 PM UTC
// =============================================================================
router.post('/weekly-reflection', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;

  for (const { user_id } of users) {
    notifyUserAsync(user_id, tenantId, 'weekly_reflection_prompt', {
      title: 'Weekly Reflection',
      body: 'Take a few minutes to reflect on your week and set intentions.',
      data: { url: '/diary' },
    }, supa);
    dispatched++;
  }

  console.log(`[Scheduled] weekly_reflection_prompt → ${dispatched} users`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /meetup-reminders — Every 15 minutes
// =============================================================================
router.post('/meetup-reminders', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const now = new Date();
  const in15min = new Date(now.getTime() + 15 * 60 * 1000);
  const in5min = new Date(now.getTime() + 5 * 60 * 1000);

  let dispatched = 0;

  // Meetups starting in ~15 minutes (meetup_starting_soon)
  const { data: soonMeetups } = await supa
    .from('community_meetups')
    .select('id, title, starts_at')
    .eq('tenant_id', tenantId)
    .gte('starts_at', now.toISOString())
    .lte('starts_at', in15min.toISOString());

  for (const meetup of soonMeetups || []) {
    // Get RSVP'd users
    const { data: rsvps } = await supa
      .from('community_meetup_attendance')
      .select('user_id')
      .eq('meetup_id', meetup.id)
      .eq('status', 'rsvp');

    for (const { user_id } of rsvps || []) {
      notifyUserAsync(user_id, tenantId, 'meetup_starting_soon', {
        title: 'Meetup Starting Soon',
        body: `"${meetup.title || 'A meetup'}" starts in about 15 minutes.`,
        data: { url: `/community/meetups/${meetup.id}`, meetup_id: meetup.id, entity_id: meetup.id },
      }, supa);
      dispatched++;
    }
  }

  // Meetups starting in ~5 minutes (meetup_starting_now)
  const { data: nowMeetups } = await supa
    .from('community_meetups')
    .select('id, title, starts_at')
    .eq('tenant_id', tenantId)
    .gte('starts_at', now.toISOString())
    .lte('starts_at', in5min.toISOString());

  for (const meetup of nowMeetups || []) {
    const { data: rsvps } = await supa
      .from('community_meetup_attendance')
      .select('user_id')
      .eq('meetup_id', meetup.id)
      .eq('status', 'rsvp');

    for (const { user_id } of rsvps || []) {
      notifyUserAsync(user_id, tenantId, 'meetup_starting_now', {
        title: 'Meetup Starting Now!',
        body: `"${meetup.title || 'A meetup'}" is starting now. Join in!`,
        data: { url: `/community/meetups/${meetup.id}`, meetup_id: meetup.id, entity_id: meetup.id },
      }, supa);
      dispatched++;
    }
  }

  console.log(`[Scheduled] meetup_reminders → ${dispatched} notifications`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /recommendation-expiry — Daily 10 AM UTC
// =============================================================================
router.post('/recommendation-expiry', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  // Find recommendations expiring in the next 24 hours
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const { data: expiring } = await supa
    .from('autopilot_recommendations')
    .select('id, user_id, title')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .lte('expires_at', tomorrow.toISOString())
    .gte('expires_at', new Date().toISOString());

  let dispatched = 0;
  for (const rec of expiring || []) {
    notifyUserAsync(rec.user_id, tenantId, 'recommendation_expires_soon', {
      title: 'Recommendation Expiring',
      body: `"${rec.title || 'A recommendation'}" expires soon. Act now!`,
      data: { url: '/autopilot', entity_id: rec.id, recommendation_id: rec.id },
    }, supa);
    dispatched++;
  }

  console.log(`[Scheduled] recommendation_expires_soon → ${dispatched} notifications`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /signal-cleanup — Daily 3 AM UTC
// =============================================================================
router.post('/signal-cleanup', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  // Find active signals that have expired
  const { data: expired } = await supa
    .from('d44_predictive_signals')
    .select('id, user_id')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .lte('expires_at', new Date().toISOString());

  let cleaned = 0;
  for (const signal of expired || []) {
    // Mark as expired
    await supa
      .from('d44_predictive_signals')
      .update({ status: 'expired' })
      .eq('id', signal.id);

    // Silent notification (no push, in-app only for audit)
    notifyUserAsync(signal.user_id, tenantId, 'signal_expired', {
      title: 'Signal Expired',
      body: 'A predictive signal has expired.',
      data: { entity_id: signal.id },
    }, supa);
    cleaned++;
  }

  console.log(`[Scheduled] signal_cleanup → ${cleaned} signals expired`);
  return res.status(200).json({ ok: true, cleaned });
});

// =============================================================================
// Health check
// =============================================================================
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true, service: 'scheduled-notifications' });
});

export default router;
