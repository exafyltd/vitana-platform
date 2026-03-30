/**
 * Scheduled Notification Webhook Endpoints
 *
 * Cloud Scheduler (or manual cron) triggers these endpoints to dispatch
 * time-based notifications to all active users in a tenant.
 *
 * VTID-01250: Upgraded from generic push to personalized content:
 *   - Morning Briefing: matches + events + unread messages + health score
 *   - Diary Reminder: social twist with connection activity
 *   - Weekly Digest: real community activity summary
 *   - Weekly Reflection: connection insights and progress
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

// ── Helper: get user display name ────────────────────────────
async function getUserName(supabase: any, userId: string): Promise<string> {
  const { data } = await supabase
    .from('app_users')
    .select('display_name')
    .eq('user_id', userId)
    .maybeSingle();
  return data?.display_name || '';
}

// ── Helper: greeting based on time of day ────────────────────
function timeGreeting(): string {
  const hour = new Date().getUTCHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// =============================================================================
// POST /morning-briefing — Daily 7 AM UTC
// AP-0501: Morning Briefing with Social Context
//
// Gathers per-user: new matches, upcoming events, unread messages, health score
// =============================================================================
router.post('/morning-briefing', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const greeting = timeGreeting();

  for (const { user_id } of users) {
    try {
      // Gather personalized data in parallel
      const [matchesRes, eventsRes, unreadRes, healthRes, nameRes] = await Promise.all([
        // Today's matches
        supa.from('matches_daily')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('user_id', user_id)
          .eq('match_date', today)
          .eq('state', 'suggested'),
        // Upcoming events (next 24h) user RSVP'd to
        supa.from('community_meetup_attendance')
          .select('meetup_id, community_meetups!inner(title, starts_at)')
          .eq('user_id', user_id)
          .eq('status', 'rsvp')
          .gte('community_meetups.starts_at', new Date().toISOString())
          .lte('community_meetups.starts_at', tomorrow)
          .limit(3),
        // Unread messages
        supa.from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .eq('receiver_id', user_id)
          .eq('tenant_id', tenantId)
          .is('read_at', null),
        // Latest Vitana Index score
        supa.from('vitana_index_scores')
          .select('score_total, score_social')
          .eq('tenant_id', tenantId)
          .eq('user_id', user_id)
          .order('date', { ascending: false })
          .limit(1)
          .maybeSingle(),
        // User name
        supa.from('app_users')
          .select('display_name')
          .eq('user_id', user_id)
          .maybeSingle(),
      ]);

      const matchCount = matchesRes.count || 0;
      const events = eventsRes.data || [];
      const unreadCount = unreadRes.count || 0;
      const healthScore = healthRes.data?.score_total || null;
      const firstName = (nameRes.data?.display_name || '').split(' ')[0];

      // Build personalized body
      const parts: string[] = [];

      if (matchCount > 0) {
        parts.push(`${matchCount} new match${matchCount > 1 ? 'es' : ''} waiting`);
      }
      if (events.length > 0) {
        const eventTitle = (events[0] as any).community_meetups?.title || 'an event';
        parts.push(events.length === 1
          ? `"${eventTitle}" today`
          : `${events.length} events today`);
      }
      if (unreadCount > 0) {
        parts.push(`${unreadCount} unread message${unreadCount > 1 ? 's' : ''}`);
      }
      if (healthScore !== null) {
        parts.push(`Vitana Index: ${healthScore}`);
      }

      const title = firstName
        ? `${greeting}, ${firstName}!`
        : `${greeting}!`;

      const body = parts.length > 0
        ? parts.join(' · ')
        : 'Check in with your community and see what\'s new today.';

      notifyUserAsync(user_id, tenantId, 'morning_briefing_ready', {
        title,
        body,
        data: {
          url: '/dashboard',
          match_count: String(matchCount),
          event_count: String(events.length),
          unread_count: String(unreadCount),
          health_score: String(healthScore || 0),
        },
      }, supa);
      dispatched++;
    } catch (err: any) {
      console.error(`[MorningBriefing] Error for user ${user_id}:`, err.message);
      // Fall back to generic notification
      notifyUserAsync(user_id, tenantId, 'morning_briefing_ready', {
        title: `${greeting}!`,
        body: 'Your daily briefing is ready. See what\'s happening today.',
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
// AP-0505: Diary Reminder with Social Twist
//
// Tells user what happened today: new connections, conversations, events attended
// =============================================================================
router.post('/diary-reminder', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartISO = todayStart.toISOString();

  for (const { user_id } of users) {
    try {
      const [sentMsgsRes, receivedMsgsRes, diaryRes] = await Promise.all([
        // Messages sent today (conversations had)
        supa.from('chat_messages')
          .select('receiver_id', { count: 'exact', head: true })
          .eq('sender_id', user_id)
          .eq('tenant_id', tenantId)
          .gte('created_at', todayStartISO),
        // Messages received today
        supa.from('chat_messages')
          .select('sender_id', { count: 'exact', head: true })
          .eq('receiver_id', user_id)
          .eq('tenant_id', tenantId)
          .gte('created_at', todayStartISO),
        // Already wrote diary today?
        supa.from('memory_diary_entries')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user_id)
          .eq('tenant_id', tenantId)
          .eq('entry_date', new Date().toISOString().slice(0, 10)),
      ]);

      const chatsSent = sentMsgsRes.count || 0;
      const chatsReceived = receivedMsgsRes.count || 0;
      const totalConversations = chatsSent + chatsReceived;
      const alreadyWrote = (diaryRes.count || 0) > 0;

      // Skip if they already wrote a diary entry today
      if (alreadyWrote) continue;

      let body: string;
      if (totalConversations > 5) {
        body = `Active day! You had ${totalConversations} messages today. Capture what stood out before it fades.`;
      } else if (totalConversations > 0) {
        body = `You connected with people today. A quick reflection helps those moments stick.`;
      } else {
        body = `Even quiet days are worth a note. What was on your mind today?`;
      }

      notifyUserAsync(user_id, tenantId, 'daily_diary_reminder', {
        title: 'Evening Reflection',
        body,
        data: {
          url: '/diary',
          conversations_today: String(totalConversations),
        },
      }, supa);
      dispatched++;
    } catch (err: any) {
      console.error(`[DiaryReminder] Error for user ${user_id}:`, err.message);
      notifyUserAsync(user_id, tenantId, 'daily_diary_reminder', {
        title: 'Diary Reminder',
        body: 'Take a moment to reflect on your day.',
        data: { url: '/diary' },
      }, supa);
      dispatched++;
    }
  }

  console.log(`[Scheduled] daily_diary_reminder → ${dispatched} users (personalized)`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /weekly-digest — Sunday 6 PM UTC
// AP-0502: Weekly Community Digest with real activity
//
// Summarizes: new connections, group activity, events attended, matches acted on
// =============================================================================
router.post('/weekly-digest', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const { user_id } of users) {
    try {
      const [matchesAcceptedRes, eventsAttendedRes, msgsRes, newMembersRes] = await Promise.all([
        // Matches accepted this week
        supa.from('matches_daily')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('user_id', user_id)
          .eq('state', 'accepted')
          .gte('state_changed_at', weekAgo),
        // Events attended this week (past meetups with attendance)
        supa.from('community_meetup_attendance')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user_id)
          .eq('status', 'attended')
          .gte('created_at', weekAgo),
        // Messages exchanged this week
        supa.from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('sender_id', user_id)
          .gte('created_at', weekAgo),
        // New community members this week (platform-wide, for community feel)
        supa.from('user_tenants')
          .select('user_id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .gte('created_at', weekAgo),
      ]);

      const accepted = matchesAcceptedRes.count || 0;
      const attended = eventsAttendedRes.count || 0;
      const msgsSent = msgsRes.count || 0;
      const newMembers = newMembersRes.count || 0;

      const highlights: string[] = [];
      if (accepted > 0) highlights.push(`${accepted} new connection${accepted > 1 ? 's' : ''}`);
      if (attended > 0) highlights.push(`${attended} event${attended > 1 ? 's' : ''} attended`);
      if (msgsSent > 0) highlights.push(`${msgsSent} message${msgsSent > 1 ? 's' : ''} sent`);
      if (newMembers > 0) highlights.push(`${newMembers} new member${newMembers > 1 ? 's' : ''} joined`);

      const body = highlights.length > 0
        ? `This week: ${highlights.join(' · ')}`
        : 'Your community is growing. Explore what\'s new this week.';

      notifyUserAsync(user_id, tenantId, 'weekly_community_digest', {
        title: 'Your Week on Vitana',
        body,
        data: {
          url: '/community',
          connections: String(accepted),
          events_attended: String(attended),
          messages_sent: String(msgsSent),
          new_members: String(newMembers),
        },
      }, supa);
      dispatched++;
    } catch (err: any) {
      console.error(`[WeeklyDigest] Error for user ${user_id}:`, err.message);
      notifyUserAsync(user_id, tenantId, 'weekly_community_digest', {
        title: 'Weekly Community Digest',
        body: 'See what happened in your community this week.',
        data: { url: '/community' },
      }, supa);
      dispatched++;
    }
  }

  console.log(`[Scheduled] weekly_community_digest → ${dispatched} users (personalized)`);
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
// AP-0506: Weekly Reflection with Connection Insights
//
// Shows: diary entries this week, connection growth, Vitana Index trend
// =============================================================================
router.post('/weekly-reflection', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  for (const { user_id } of users) {
    try {
      const [diaryRes, connectionsRes, healthThisWeekRes, healthLastWeekRes] = await Promise.all([
        // Diary entries this week
        supa.from('memory_diary_entries')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user_id)
          .eq('tenant_id', tenantId)
          .gte('created_at', weekAgo),
        // New connections this week
        supa.from('relationship_edges')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user_id)
          .eq('tenant_id', tenantId)
          .eq('relationship_type', 'friend')
          .gte('created_at', weekAgo),
        // Vitana Index this week (latest)
        supa.from('vitana_index_scores')
          .select('score_total')
          .eq('tenant_id', tenantId)
          .eq('user_id', user_id)
          .gte('date', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
          .order('date', { ascending: false })
          .limit(1)
          .maybeSingle(),
        // Vitana Index last week (for trend)
        supa.from('vitana_index_scores')
          .select('score_total')
          .eq('tenant_id', tenantId)
          .eq('user_id', user_id)
          .gte('date', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
          .lt('date', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
          .order('date', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      const diaryCount = diaryRes.count || 0;
      const newConnections = connectionsRes.count || 0;
      const scoreNow = healthThisWeekRes.data?.score_total || null;
      const scorePrev = healthLastWeekRes.data?.score_total || null;

      const insights: string[] = [];

      if (diaryCount > 0) {
        insights.push(`${diaryCount} diary entr${diaryCount > 1 ? 'ies' : 'y'} this week`);
      }
      if (newConnections > 0) {
        insights.push(`${newConnections} new connection${newConnections > 1 ? 's' : ''}`);
      }
      if (scoreNow !== null && scorePrev !== null) {
        const diff = scoreNow - scorePrev;
        if (diff > 0) insights.push(`Vitana Index up ${diff} points`);
        else if (diff < 0) insights.push(`Vitana Index down ${Math.abs(diff)} points`);
        else insights.push(`Vitana Index steady at ${scoreNow}`);
      } else if (scoreNow !== null) {
        insights.push(`Vitana Index: ${scoreNow}`);
      }

      let body: string;
      if (insights.length > 0) {
        body = insights.join(' · ') + '. What intentions will you set for next week?';
      } else {
        body = 'Take a few minutes to look back on your week and set intentions for the next one.';
      }

      notifyUserAsync(user_id, tenantId, 'weekly_reflection_prompt', {
        title: 'Weekly Reflection',
        body,
        data: {
          url: '/diary',
          diary_count: String(diaryCount),
          new_connections: String(newConnections),
          vitana_score: String(scoreNow || 0),
        },
      }, supa);
      dispatched++;
    } catch (err: any) {
      console.error(`[WeeklyReflection] Error for user ${user_id}:`, err.message);
      notifyUserAsync(user_id, tenantId, 'weekly_reflection_prompt', {
        title: 'Weekly Reflection',
        body: 'Take a few minutes to reflect on your week and set intentions.',
        data: { url: '/diary' },
      }, supa);
      dispatched++;
    }
  }

  console.log(`[Scheduled] weekly_reflection_prompt → ${dispatched} users (personalized)`);
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
