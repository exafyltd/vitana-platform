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
import { notifyUserAsync, sendPushToUser, sendAppilixPush } from '../services/notification-service';
import { generatePersonalRecommendations } from '../services/recommendation-engine';

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
// POST /morning-briefing — Daily 7 AM UTC (Personalized from Maxina)
// =============================================================================

const MORNING_GREETINGS = [
  'Guten Morgen',
  'Schönen guten Morgen',
  'Einen wunderschönen Morgen',
  'Hey',
  'Hallo',
  'Moin',
];

const MAXINA_CLOSINGS = [
  'Deine Maxina wünscht dir einen tollen Tag!',
  'Ich bin da, wenn du mich brauchst. Deine Maxina.',
  'Lass uns gemeinsam einen guten Tag machen!',
  'Du schaffst das! Deine Maxina.',
  'Einen schönen Tag wünscht dir Maxina.',
  'Maxina glaubt an dich!',
  'Mach das Beste aus heute! Deine Maxina.',
];

interface BriefingContext {
  userName: string | null;
  healthScore: number | null;
  healthTrend: 'steigend' | 'stabil' | 'sinkend' | null;
  diaryMood: string | null;
  diaryStreak: number;
  pendingMatchCount: number;
  newRecCount: number;
  connectionCount: number;
}

async function gatherBriefingContext(supa: any, userId: string, tenantId: string): Promise<BriefingContext> {
  const [nameResult, healthResult, diaryResult, matchResult, recResult, connResult, streakResult] = await Promise.all([
    supa.from('memory_facts').select('fact_value').eq('user_id', userId).in('fact_key', ['display_name', 'name']).limit(1),
    supa.from('vitana_index_scores').select('score_total').eq('user_id', userId).order('created_at', { ascending: false }).limit(2),
    supa.from('memory_items').select('tags, metadata').eq('user_id', userId).eq('item_type', 'diary').order('created_at', { ascending: false }).limit(1),
    supa.from('matches_daily').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('tenant_id', tenantId).is('feedback', null),
    supa.from('autopilot_recommendations').select('id', { count: 'exact', head: true }).eq('status', 'new').or(`user_id.is.null,user_id.eq.${userId}`),
    supa.from('relationship_edges').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('tenant_id', tenantId).eq('target_type', 'person').eq('relationship_type', 'connected'),
    supa.from('memory_items').select('created_at').eq('user_id', userId).eq('item_type', 'diary').order('created_at', { ascending: false }).limit(14),
  ]);

  // Parse health trend
  const healthRows = healthResult.data || [];
  let healthScore: number | null = null;
  let healthTrend: 'steigend' | 'stabil' | 'sinkend' | null = null;
  if (healthRows.length > 0) {
    healthScore = healthRows[0].score_total;
    if (healthRows.length > 1) {
      const delta = healthRows[0].score_total - healthRows[1].score_total;
      healthTrend = delta > 2 ? 'steigend' : delta < -2 ? 'sinkend' : 'stabil';
    }
  }

  // Parse diary mood
  let diaryMood: string | null = null;
  if (diaryResult.data?.length > 0) {
    const meta = diaryResult.data[0].metadata as any;
    const tags = diaryResult.data[0].tags as string[] || [];
    diaryMood = meta?.mood || tags.find((t: string) => ['happy', 'sad', 'anxious', 'calm', 'stressed', 'energetic', 'tired'].includes(t)) || null;
  }

  // Calculate diary streak
  let diaryStreak = 0;
  const entries = streakResult.data || [];
  if (entries.length > 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let checkDate = new Date(today);
    for (const entry of entries) {
      const entryDate = new Date(entry.created_at);
      entryDate.setHours(0, 0, 0, 0);
      if (entryDate.getTime() === checkDate.getTime()) {
        diaryStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else if (entryDate.getTime() < checkDate.getTime()) {
        if (checkDate.getTime() - entryDate.getTime() <= 86400000) {
          checkDate = new Date(entryDate);
          diaryStreak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    }
  }

  return {
    userName: nameResult.data?.[0]?.fact_value || null,
    healthScore,
    healthTrend,
    diaryMood,
    diaryStreak,
    pendingMatchCount: matchResult.count || 0,
    newRecCount: recResult.count || 0,
    connectionCount: connResult.count || 0,
  };
}

function composeMorningBriefing(ctx: BriefingContext): string {
  const parts: string[] = [];

  // 1. Greeting
  const greeting = MORNING_GREETINGS[Math.floor(Math.random() * MORNING_GREETINGS.length)];
  parts.push(ctx.userName ? `${greeting}, ${ctx.userName}!` : `${greeting}!`);

  // 2. Health pulse
  if (ctx.healthScore !== null) {
    const trendEmoji = ctx.healthTrend === 'steigend' ? '↑' : ctx.healthTrend === 'sinkend' ? '↓' : '→';
    parts.push(`Dein Vitana-Index: ${ctx.healthScore}/100 ${trendEmoji}`);
  }

  // 3. Mood acknowledgment
  if (ctx.diaryMood) {
    const moodMessages: Record<string, string> = {
      sad: 'Gestern war ein schwieriger Tag. Heute wird besser!',
      anxious: 'Ich sehe, dass es dir nicht so gut ging. Ich bin für dich da.',
      stressed: 'Lass uns heute etwas ruhiger angehen.',
      happy: 'Toll, dass es dir gut geht! Weiter so!',
      energetic: 'Du hattest gestern richtig viel Energie!',
      calm: 'Schön, dass du ausgeglichen bist.',
      tired: 'Nimm dir heute Zeit für dich.',
    };
    if (moodMessages[ctx.diaryMood]) {
      parts.push(moodMessages[ctx.diaryMood]);
    }
  }

  // 4. Streak celebration
  if (ctx.diaryStreak >= 7) {
    parts.push(`${ctx.diaryStreak}-Tage-Tagebuch-Serie! Beeindruckend!`);
  } else if (ctx.diaryStreak >= 3) {
    parts.push(`Schon ${ctx.diaryStreak} Tage in Folge Tagebuch geschrieben. Bleib dran!`);
  }

  // 5. Social pulse
  if (ctx.pendingMatchCount > 0) {
    parts.push(`${ctx.pendingMatchCount} neue Match${ctx.pendingMatchCount > 1 ? 'es' : ''} warten auf dich.`);
  }

  // 6. Recommendations
  if (ctx.newRecCount > 0) {
    parts.push(`${ctx.newRecCount} Autopilot-Aktion${ctx.newRecCount > 1 ? 'en' : ''} bereit.`);
  }

  // 7. Closing
  const closing = MAXINA_CLOSINGS[Math.floor(Math.random() * MAXINA_CLOSINGS.length)];
  parts.push(closing);

  return parts.join(' ');
}

router.post('/morning-briefing', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;

  for (const { user_id } of users) {
    try {
      // Generate fresh personal recommendations for this user
      await generatePersonalRecommendations(user_id, tenantId, { trigger_type: 'scheduled' });

      // Gather briefing context and compose personalized message
      const ctx = await gatherBriefingContext(supa, user_id, tenantId);
      const briefingBody = composeMorningBriefing(ctx);

      notifyUserAsync(user_id, tenantId, 'morning_briefing_ready', {
        title: ctx.userName ? `${MORNING_GREETINGS[Math.floor(Math.random() * MORNING_GREETINGS.length)]}, ${ctx.userName}!` : 'Guten Morgen!',
        body: briefingBody,
        data: { url: '/dashboard' },
      }, supa);
      dispatched++;
    } catch (err: any) {
      console.warn(`[Scheduled] morning_briefing error for ${user_id.slice(0, 8)}: ${err.message}`);
      // Fallback to basic notification
      notifyUserAsync(user_id, tenantId, 'morning_briefing_ready', {
        title: 'Guten Morgen!',
        body: 'Dein tägliches Briefing ist bereit. Schau mal rein!',
        data: { url: '/dashboard' },
      }, supa);
      dispatched++;
    }
  }

  console.log(`[Scheduled] morning_briefing_ready → ${dispatched} users (personalized)`);
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
// POST /push-dispatch — Every 30 seconds (Cloud Scheduler)
// Picks up trigger-created notifications that haven't had FCM push sent yet.
// DB triggers (chat messages, group invites, predictive signals, etc.) write
// to user_notifications but can't send FCM. This cron bridges the gap.
// =============================================================================
router.post('/push-dispatch', async (req: Request, res: Response) => {
  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  // Find notifications created by DB triggers that haven't been pushed yet.
  // push_sent_at IS NULL  → not yet pushed
  // channel includes push → should be pushed
  // created in last 5 min → don't bother with very old ones
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: pending, error } = await supa
    .from('user_notifications')
    .select('id, user_id, tenant_id, type, title, body, data, channel, priority')
    .is('push_sent_at', null)
    .in('channel', ['push', 'push_and_inapp'])
    .gte('created_at', fiveMinAgo)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) {
    console.error('[PushDispatch] Query error:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  if (!pending?.length) {
    return res.status(200).json({ ok: true, dispatched: 0, message: 'no pending pushes' });
  }

  let dispatched = 0;
  let skipped = 0;

  for (const notif of pending) {
    try {
      // Check user preferences (DND, category toggles, push_enabled)
      const { data: prefs } = await supa
        .from('user_notification_preferences')
        .select('*')
        .eq('user_id', notif.user_id)
        .eq('tenant_id', notif.tenant_id)
        .maybeSingle();

      // If push disabled globally, skip push but still mark as handled
      if (prefs?.push_enabled === false) {
        await supa.from('user_notifications')
          .update({ push_sent_at: new Date().toISOString() })
          .eq('id', notif.id);
        skipped++;
        continue;
      }

      // DND check — p0 bypasses DND
      if (prefs?.dnd_enabled && prefs.dnd_start_time && prefs.dnd_end_time && notif.priority !== 'p0') {
        const now = new Date();
        const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const start = prefs.dnd_start_time;
        const end = prefs.dnd_end_time;
        const inDnd = start > end ? (hhmm >= start || hhmm < end) : (hhmm >= start && hhmm < end);
        if (inDnd) {
          await supa.from('user_notifications')
            .update({ push_sent_at: new Date().toISOString() })
            .eq('id', notif.id);
          skipped++;
          continue;
        }
      }

      // Send FCM web push + Appilix native push
      const pushPayload = {
        title: notif.title || 'Vitana',
        body: notif.body || '',
        data: typeof notif.data === 'object' && notif.data !== null
          ? Object.fromEntries(Object.entries(notif.data).map(([k, v]) => [k, String(v)]))
          : undefined,
      };
      const sent = await sendPushToUser(notif.user_id, notif.tenant_id, pushPayload, supa);
      const appilixSent = await sendAppilixPush(notif.user_id, pushPayload);

      // Mark as dispatched
      await supa.from('user_notifications')
        .update({ push_sent_at: new Date().toISOString() })
        .eq('id', notif.id);

      if (sent > 0 || appilixSent) dispatched++;
      else skipped++; // No device tokens found and Appilix not configured
    } catch (err: any) {
      console.error(`[PushDispatch] Failed for notification ${notif.id}:`, err.message || err);
      // Still mark as sent to avoid infinite retries
      await supa.from('user_notifications')
        .update({ push_sent_at: new Date().toISOString() })
        .eq('id', notif.id);
      skipped++;
    }
  }

  console.log(`[PushDispatch] dispatched=${dispatched} skipped=${skipped} total=${pending.length}`);
  return res.status(200).json({ ok: true, dispatched, skipped, total: pending.length });
});

// =============================================================================
// POST /recommendation-cleanup — Daily 3 AM UTC (alongside signal-cleanup)
// VTID-01185: Clean up expired/stale recommendations
// =============================================================================
router.post('/recommendation-cleanup', async (_req: Request, res: Response) => {
  try {
    const supa = await getServiceClient();
    if (!supa) return res.status(500).json({ ok: false, error: 'Missing Supabase credentials' });

    const now = new Date().toISOString();
    let expired = 0;
    let unsnoozed = 0;
    let stalePurged = 0;

    // 1. Expire recommendations past their expires_at
    const { count: expiredCount } = await supa
      .from('autopilot_recommendations')
      .update({ status: 'rejected', updated_at: now })
      .eq('status', 'new')
      .not('expires_at', 'is', null)
      .lt('expires_at', now);
    expired = expiredCount || 0;

    // 2. Unsnoze past-due snoozed recommendations
    const { count: unsnoozedCount } = await supa
      .from('autopilot_recommendations')
      .update({ status: 'new', snoozed_until: null, updated_at: now })
      .eq('status', 'snoozed')
      .lt('snoozed_until', now);
    unsnoozed = unsnoozedCount || 0;

    // 3. Purge stale seed data (no fingerprint, >30 days old)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { count: staleCount } = await supa
      .from('autopilot_recommendations')
      .update({ status: 'rejected', updated_at: now })
      .eq('status', 'new')
      .is('fingerprint', null)
      .lt('created_at', thirtyDaysAgo);
    stalePurged = staleCount || 0;

    // 4. Try RPC cleanup if available
    try {
      await supa.rpc('cleanup_expired_autopilot_recommendations');
    } catch {
      // RPC may not exist yet
    }

    console.log(`[RecommendationCleanup] expired=${expired} unsnoozed=${unsnoozed} stale_purged=${stalePurged}`);
    return res.status(200).json({
      ok: true,
      expired,
      unsnoozed,
      stale_purged: stalePurged,
      timestamp: now,
    });
  } catch (err: any) {
    console.error('[RecommendationCleanup] Error:', err.message || err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// Health check
// =============================================================================
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true, service: 'scheduled-notifications' });
});

export default router;
