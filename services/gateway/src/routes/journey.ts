/**
 * Journey Screen API — Visual overview of a user's autopilot journey
 *
 * Provides the data model for the Journey screen: a timeline of all
 * autopilot automations organized by rhythm (daily/weekly/event-driven),
 * enriched with per-user status and recent activity.
 *
 * Endpoints:
 *   GET /api/v1/journey/timeline    — Full journey timeline for the user
 *   GET /api/v1/journey/stats       — Journey progress stats (completion, streaks)
 *   GET /api/v1/journey/onboarding  — Onboarding checklist status
 */

import { Router, Response } from 'express';
import {
  requireAuth,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { AUTOMATION_REGISTRY } from '../services/automation-registry';
import { AutomationDefinition } from '../types/automations';

const router = Router();

// ── Helper: get service-role Supabase client ─────────────────
async function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

// ── Domain display metadata ──────────────────────────────────
const DOMAIN_META: Record<string, { label: string; icon: string; color: string }> = {
  'connect-people':           { label: 'Connect People',        icon: 'users',          color: '#6366f1' },
  'community-groups':         { label: 'Community & Groups',    icon: 'users-round',    color: '#8b5cf6' },
  'events-live-rooms':        { label: 'Events & Live Rooms',   icon: 'calendar',       color: '#ec4899' },
  'sharing-growth':           { label: 'Sharing & Growth',      icon: 'share-2',        color: '#f59e0b' },
  'engagement-loops':         { label: 'Engagement Loops',      icon: 'refresh-cw',     color: '#10b981' },
  'health-wellness':          { label: 'Health & Wellness',     icon: 'heart-pulse',    color: '#ef4444' },
  'payments-wallet-vtn':      { label: 'Payments & Wallet',     icon: 'wallet',         color: '#0ea5e9' },
  'personalization-engines':  { label: 'Personalization',       icon: 'sparkles',       color: '#a855f7' },
  'memory-intelligence':      { label: 'Memory & Intelligence', icon: 'brain',          color: '#6366f1' },
  'platform-operations':      { label: 'Platform Operations',   icon: 'settings',       color: '#64748b' },
  'business-hub-marketplace': { label: 'Business & Marketplace', icon: 'store',         color: '#f97316' },
  'live-rooms-commerce':      { label: 'Live Rooms Commerce',   icon: 'video',          color: '#14b8a6' },
};

// ── Rhythm classification ────────────────────────────────────
type Rhythm = 'morning' | 'evening' | 'weekly' | 'event_driven' | 'heartbeat' | 'background';

function classifyRhythm(def: AutomationDefinition): Rhythm {
  // Morning automations
  if (['AP-0501'].includes(def.id)) return 'morning';
  if (def.triggerConfig?.cronExpression?.includes('7 *')) return 'morning';

  // Evening automations
  if (['AP-0505'].includes(def.id)) return 'evening';
  if (def.triggerConfig?.cronExpression?.includes('21 *')) return 'evening';

  // Weekly automations
  if (['AP-0502', 'AP-0506', 'AP-0611'].includes(def.id)) return 'weekly';
  if (def.triggerConfig?.cronExpression?.match(/\* \* [0-6]$/)) return 'weekly';

  // Event-driven
  if (def.triggerType === 'event') return 'event_driven';

  // Heartbeat
  if (def.triggerType === 'heartbeat') return 'heartbeat';

  // Cron defaults
  if (def.triggerType === 'cron') return 'background';

  return 'background';
}

// ── User-facing description for each automation ──────────────
const JOURNEY_DESCRIPTIONS: Record<string, string> = {
  // Morning
  'AP-0501': 'Your personalized morning briefing with matches, events, and health insights',
  // Evening
  'AP-0505': 'Evening diary prompt reflecting on your social connections today',
  // Weekly
  'AP-0502': 'Weekly digest of your community activity and new connections',
  'AP-0506': 'Weekly reflection with connection growth and Vitana Index trends',
  'AP-0611': 'Weekly health score report across all 5 wellness pillars',
  // Connect
  'AP-0101': 'Daily delivery of your best people, group, and event matches',
  'AP-0102': 'Notifies you when someone shares your interests',
  'AP-0103': 'Automatically introduces you when both sides accept a match',
  'AP-0104': 'Suggests conversation starters for new connections',
  'AP-0105': 'Recommends groups that fit your interests',
  'AP-0107': 'Proactive suggestions to deepen social alignment',
  'AP-0108': 'Learns from your match feedback to improve future matches',
  'AP-0109': 'Batches and delivers the best match opportunities',
  // Community
  'AP-0202': 'Follows up when you receive a group invitation',
  'AP-0203': 'Welcomes you when you join a new group',
  'AP-0207': 'Encourages you to RSVP for meetups matching your interests',
  'AP-0208': 'Suggests connecting with people you met at events',
  'AP-0210': 'Digest for group creators about their community activity',
  // Events
  'AP-0303': 'Finds friends attending the same events so you can go together',
  'AP-0304': 'Asks for feedback after events to improve future ones',
  'AP-0308': 'Follows up if you missed an event you RSVP\'d to',
  // Engagement
  'AP-0503': 'Reaches out if you haven\'t been active in 7 days',
  'AP-0504': 'Celebrates your milestones and achievements',
  'AP-0507': 'Nudges you to continue conversations that went quiet',
  // Sharing
  'AP-0401': 'Creates WhatsApp share links for events',
  'AP-0402': 'Creates WhatsApp invite links for groups',
  'AP-0404': 'Suggests inviting friends after positive experiences',
  'AP-0405': 'Tracks referrals and rewards successful ones',
  'AP-0408': 'Prompts sharing event countdowns',
  'AP-0410': 'Onboards new users who arrive via shared links',
  // Health
  'AP-0604': 'Periodic wellness check-in prompts',
  'AP-0607': 'Processes lab reports and extracts health biomarkers',
  'AP-0608': 'Analyzes trends in your biomarker data over time',
  'AP-0609': 'Generates quality-of-life recommendations from health data',
  'AP-0612': 'Suggests professional referrals based on health trends',
  'AP-0615': 'Recommends products aligned with your health profile',
  // Payments
  'AP-0701': 'Detects payment failures and retries automatically',
  'AP-0702': 'Audits subscription activity',
  'AP-0705': 'Reminds you to update payment methods before expiry',
  'AP-0706': 'Guides creators through Stripe Connect setup',
  'AP-0707': 'Monitors creator payout health',
  'AP-0708': 'Awards wallet credits for engagement activities',
  'AP-0710': 'Scores creators\' readiness for monetization',
  'AP-0711': 'Weekly earnings report for creators',
  // Business
  'AP-1101': 'Distributes service listings to matched users',
  'AP-1102': 'Matches products with users via AI-powered picks',
  'AP-1103': 'Personalizes the Discover section based on your interests',
  'AP-1104': 'Matches clients with relevant services',
  'AP-1105': 'Tracks outcomes after service sessions',
  'AP-1106': 'Guides you through setting up your shop',
  'AP-1107': 'Follows up for product/service reviews',
  'AP-1108': 'Delivers growth tips and analytics for creators',
  'AP-1110': 'Cross-sells relevant services to product buyers',
  // Live Rooms
  'AP-1201': 'Sets up paid live room with pricing and booking',
  'AP-1202': 'Handles booking and payment for live rooms',
  'AP-1203': 'Upsells premium live rooms from free content',
  'AP-1204': 'Auto-fills group sessions with matched participants',
  'AP-1205': 'Post-session revenue report for creators',
  'AP-1207': 'Auto-schedules recurring sessions',
  'AP-1208': 'Matches users with relevant consultants',
  'AP-1209': 'Suggests free trial sessions for new creators',
};

// ── Onboarding checklist definition ──────────────────────────
interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  icon: string;
  checkFn: (supabase: any, userId: string, tenantId: string) => Promise<boolean>;
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'profile_complete',
    title: 'Complete Your Profile',
    description: 'Add your display name and photo so people can find you',
    icon: 'user',
    checkFn: async (supa, userId) => {
      const { data } = await supa.from('app_users')
        .select('display_name')
        .eq('user_id', userId)
        .maybeSingle();
      return !!(data?.display_name);
    },
  },
  {
    id: 'topics_selected',
    title: 'Choose Your Interests',
    description: 'Select topics you care about so we can find your people',
    icon: 'heart',
    checkFn: async (supa, userId, tenantId) => {
      const { count } = await supa.from('user_topic_preferences')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('tenant_id', tenantId);
      return (count || 0) >= 3;
    },
  },
  {
    id: 'first_match_reviewed',
    title: 'Review Your First Match',
    description: 'Accept or dismiss a match to train your preferences',
    icon: 'users',
    checkFn: async (supa, userId, tenantId) => {
      const { count } = await supa.from('matches_daily')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('tenant_id', tenantId)
        .neq('state', 'suggested');
      return (count || 0) >= 1;
    },
  },
  {
    id: 'first_message_sent',
    title: 'Send Your First Message',
    description: 'Start a conversation with a match or group member',
    icon: 'message-circle',
    checkFn: async (supa, userId, tenantId) => {
      const { count } = await supa.from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_id', userId)
        .eq('tenant_id', tenantId);
      return (count || 0) >= 1;
    },
  },
  {
    id: 'joined_group',
    title: 'Join a Group',
    description: 'Find a community group that matches your interests',
    icon: 'users-round',
    checkFn: async (supa, userId, tenantId) => {
      const { count } = await supa.from('community_memberships')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('tenant_id', tenantId)
        .eq('status', 'active');
      return (count || 0) >= 1;
    },
  },
  {
    id: 'first_diary_entry',
    title: 'Write Your First Diary Entry',
    description: 'Capture a thought, reflection, or health check-in',
    icon: 'book-open',
    checkFn: async (supa, userId, tenantId) => {
      const { count } = await supa.from('memory_diary_entries')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('tenant_id', tenantId);
      return (count || 0) >= 1;
    },
  },
  {
    id: 'notification_prefs_set',
    title: 'Set Your Notification Preferences',
    description: 'Choose quiet hours and notification frequency',
    icon: 'bell',
    checkFn: async (supa, userId, tenantId) => {
      const { data } = await supa.from('user_notification_preferences')
        .select('id')
        .eq('user_id', userId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      return !!data;
    },
  },
];

// =============================================================================
// GET /timeline — Full journey timeline for the authenticated user
//
// Returns automations organized by rhythm, with per-user status:
//   - daily rhythm (morning briefing, diary reminder)
//   - weekly rhythm (digest, reflection, health report)
//   - event-driven (triggers based on user actions)
//   - background (heartbeat automations working silently)
// =============================================================================
router.get('/timeline', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const identity = req.identity!;
  const userId = identity.user_id;
  const tenantId = identity.tenant_id;

  const supa = await getServiceClient();

  // Get user's role to filter relevant automations
  let userRole = 'community';
  if (supa && tenantId) {
    const { data: ut } = await supa.from('user_tenants')
      .select('active_role')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    userRole = ut?.active_role || 'community';
  }

  // Get recent automation runs for this user (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  let recentRuns: Record<string, { last_run: string; runs_count: number }> = {};

  if (supa && tenantId) {
    const { data: runs } = await supa.from('automation_runs')
      .select('automation_id, started_at, status')
      .eq('tenant_id', tenantId)
      .gte('started_at', weekAgo)
      .eq('status', 'completed')
      .order('started_at', { ascending: false })
      .limit(200);

    for (const run of runs || []) {
      if (!recentRuns[run.automation_id]) {
        recentRuns[run.automation_id] = { last_run: run.started_at, runs_count: 0 };
      }
      recentRuns[run.automation_id].runs_count++;
    }
  }

  // Build timeline entries
  const timeline: Array<{
    id: string;
    name: string;
    description: string;
    domain: string;
    domainLabel: string;
    domainIcon: string;
    domainColor: string;
    rhythm: Rhythm;
    status: string;
    priority: string;
    triggerType: string;
    schedule?: string;
    lastRun?: string;
    runsThisWeek: number;
    isActive: boolean;
    isRelevantToRole: boolean;
  }> = [];

  for (const def of AUTOMATION_REGISTRY) {
    // Check role relevance
    const isRelevant = def.targetRoles === 'all' ||
      (Array.isArray(def.targetRoles) && def.targetRoles.includes(userRole as any));

    const domainMeta = DOMAIN_META[def.domain] || { label: def.domain, icon: 'circle', color: '#6b7280' };
    const runInfo = recentRuns[def.id];
    const isActive = (def.status === 'IMPLEMENTED' || def.status === 'LIVE') && !!def.handler;

    timeline.push({
      id: def.id,
      name: def.name,
      description: JOURNEY_DESCRIPTIONS[def.id] || def.name,
      domain: def.domain,
      domainLabel: domainMeta.label,
      domainIcon: domainMeta.icon,
      domainColor: domainMeta.color,
      rhythm: classifyRhythm(def),
      status: def.status,
      priority: def.priority,
      triggerType: def.triggerType,
      schedule: def.triggerConfig?.cronExpression,
      lastRun: runInfo?.last_run,
      runsThisWeek: runInfo?.runs_count || 0,
      isActive,
      isRelevantToRole: isRelevant,
    });
  }

  // Group by rhythm for the UI
  const grouped = {
    morning: timeline.filter(t => t.rhythm === 'morning'),
    evening: timeline.filter(t => t.rhythm === 'evening'),
    weekly: timeline.filter(t => t.rhythm === 'weekly'),
    event_driven: timeline.filter(t => t.rhythm === 'event_driven'),
    heartbeat: timeline.filter(t => t.rhythm === 'heartbeat'),
    background: timeline.filter(t => t.rhythm === 'background'),
  };

  // Summary counts
  const total = AUTOMATION_REGISTRY.length;
  const active = timeline.filter(t => t.isActive).length;
  const relevant = timeline.filter(t => t.isRelevantToRole).length;
  const ranThisWeek = timeline.filter(t => t.runsThisWeek > 0).length;

  return res.json({
    ok: true,
    userRole,
    summary: { total, active, relevant, ranThisWeek },
    grouped,
    timeline,
  });
});

// =============================================================================
// GET /stats — Journey progress stats (completion %, streaks, milestones)
// =============================================================================
router.get('/stats', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const identity = req.identity!;
  const userId = identity.user_id;
  const tenantId = identity.tenant_id;

  const supa = await getServiceClient();
  if (!supa || !tenantId) {
    return res.json({ ok: true, stats: null, message: 'Supabase not configured' });
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    connectionsRes,
    matchesActedRes,
    diaryCountRes,
    eventsAttendedRes,
    healthScoreRes,
    messagesRes,
    groupsRes,
    streakRes,
  ] = await Promise.all([
    // Total connections
    supa.from('relationship_edges')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('relationship_type', 'friend'),
    // Matches acted on (last 30 days)
    supa.from('matches_daily')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .neq('state', 'suggested')
      .gte('state_changed_at', thirtyDaysAgo),
    // Diary entries (last 30 days)
    supa.from('memory_diary_entries')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .gte('created_at', thirtyDaysAgo),
    // Events attended (all time)
    supa.from('community_meetup_attendance')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'attended'),
    // Latest Vitana Index
    supa.from('vitana_index_scores')
      .select('score_total, score_physical, score_mental, score_nutritional, score_social, score_environmental, date')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Messages sent (last 7 days)
    supa.from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_id', userId)
      .eq('tenant_id', tenantId)
      .gte('created_at', weekAgo),
    // Groups joined
    supa.from('community_memberships')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('status', 'active'),
    // Diary streak: diary entries per day in the last 7 days
    supa.from('memory_diary_entries')
      .select('entry_date')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .gte('entry_date', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
      .order('entry_date', { ascending: false }),
  ]);

  // Calculate diary streak (consecutive days with entries ending today)
  const diaryDates = new Set((streakRes.data || []).map((d: any) => d.entry_date));
  let diaryStreak = 0;
  for (let i = 0; i < 30; i++) {
    const checkDate = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (diaryDates.has(checkDate)) {
      diaryStreak++;
    } else {
      break;
    }
  }

  const healthScore = healthScoreRes.data;

  return res.json({
    ok: true,
    stats: {
      connections: connectionsRes.count || 0,
      matchesActed30d: matchesActedRes.count || 0,
      diaryEntries30d: diaryCountRes.count || 0,
      diaryStreak,
      eventsAttended: eventsAttendedRes.count || 0,
      messagesSent7d: messagesRes.count || 0,
      groupsJoined: groupsRes.count || 0,
      vitanaIndex: healthScore ? {
        total: healthScore.score_total,
        physical: healthScore.score_physical,
        mental: healthScore.score_mental,
        nutritional: healthScore.score_nutritional,
        social: healthScore.score_social,
        environmental: healthScore.score_environmental,
        date: healthScore.date,
      } : null,
    },
  });
});

// =============================================================================
// GET /onboarding — Onboarding checklist status
//
// Returns step-by-step onboarding progress with completion status
// =============================================================================
router.get('/onboarding', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const identity = req.identity!;
  const userId = identity.user_id;
  const tenantId = identity.tenant_id;

  const supa = await getServiceClient();
  if (!supa || !tenantId) {
    return res.json({ ok: true, steps: [], completed: 0, total: 0 });
  }

  const steps: Array<{
    id: string;
    title: string;
    description: string;
    icon: string;
    completed: boolean;
  }> = [];

  let completedCount = 0;

  for (const step of ONBOARDING_STEPS) {
    let completed = false;
    try {
      completed = await step.checkFn(supa, userId, tenantId);
    } catch {
      // If check fails, treat as incomplete
    }
    if (completed) completedCount++;

    steps.push({
      id: step.id,
      title: step.title,
      description: step.description,
      icon: step.icon,
      completed,
    });
  }

  return res.json({
    ok: true,
    steps,
    completed: completedCount,
    total: ONBOARDING_STEPS.length,
    percentage: Math.round((completedCount / ONBOARDING_STEPS.length) * 100),
    allComplete: completedCount === ONBOARDING_STEPS.length,
  });
});

// =============================================================================
// Health check
// =============================================================================
router.get('/health', (_req: any, res: Response) => {
  return res.status(200).json({ ok: true, service: 'journey' });
});

export default router;
