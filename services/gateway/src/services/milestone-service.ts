/**
 * Milestone Detection Service
 *
 * VTID: VTID-01250
 * Detects user milestones and emits `user.milestone.reached` OASIS events.
 * These events trigger AP-0504 (Milestone Celebrations) and AP-1306 (Auto-Share).
 *
 * Milestones are idempotent: once achieved, they're recorded in the
 * `user_milestones` metadata on the user's tenant row and won't re-fire.
 *
 * Two modes:
 * 1. Event-driven: called inline when a relevant action completes (fast path)
 * 2. Heartbeat scan: periodic sweep for milestones that can't be detected inline
 */

import { SupabaseClient } from '@supabase/supabase-js';
import * as repo from './milestone-service-repository';

// =============================================================================
// Milestone Definitions
// =============================================================================

export interface MilestoneDefinition {
  id: string;
  name: string;
  /** Human-readable celebration message */
  celebration: string;
  /** Emoji for notification (single char) */
  icon: string;
  /** Category for grouping */
  category: 'onboarding' | 'social' | 'engagement' | 'health' | 'creator';
  /** Wallet reward amount (0 = no reward) */
  reward: number;
  /** Deep link target for the notification */
  target: string;
}

export const MILESTONES: Record<string, MilestoneDefinition> = {
  // ── Onboarding ──────────────────────────────────────────────
  onboarding_complete: {
    id: 'onboarding_complete',
    name: 'Onboarding Complete',
    celebration: 'You completed your onboarding! Vitana is all set up for you.',
    icon: '🎉',
    category: 'onboarding',
    reward: 50,
    target: '/autopilot',
  },
  profile_complete: {
    id: 'profile_complete',
    name: 'Profile Complete',
    celebration: 'Your profile is looking great! Others can now find and connect with you.',
    icon: '✨',
    category: 'onboarding',
    reward: 20,
    target: '/profile',
  },
  first_diary: {
    id: 'first_diary',
    name: 'First Diary Entry',
    celebration: 'You wrote your first diary entry! Reflection is the first step to growth.',
    icon: '📖',
    category: 'engagement',
    reward: 15,
    target: '/diary',
  },

  // ── Social ──────────────────────────────────────────────────
  first_connection: {
    id: 'first_connection',
    name: 'First Connection',
    celebration: 'You made your first connection! Your community journey begins.',
    icon: '🤝',
    category: 'social',
    reward: 20,
    target: '/connections',
  },
  five_connections: {
    id: 'five_connections',
    name: '5 Connections',
    celebration: 'You have 5 connections now! Your network is growing.',
    icon: '🌱',
    category: 'social',
    reward: 30,
    target: '/connections',
  },
  first_group: {
    id: 'first_group',
    name: 'First Group Joined',
    celebration: 'You joined your first group! Great way to meet like-minded people.',
    icon: '👥',
    category: 'social',
    reward: 15,
    target: '/groups',
  },
  first_event_rsvp: {
    id: 'first_event_rsvp',
    name: 'First Event RSVP',
    celebration: 'You RSVP\'d to your first event! We\'ll remind you when it\'s time.',
    icon: '📅',
    category: 'social',
    reward: 15,
    target: '/events',
  },
  first_match_accepted: {
    id: 'first_match_accepted',
    name: 'First Match Accepted',
    celebration: 'You accepted your first match! Start a conversation to get to know them.',
    icon: '💫',
    category: 'social',
    reward: 20,
    target: '/matches',
  },

  // ── Engagement Streaks ──────────────────────────────────────
  diary_streak_3: {
    id: 'diary_streak_3',
    name: '3-Day Diary Streak',
    celebration: 'Three days in a row! You\'re building a healthy reflection habit.',
    icon: '🔥',
    category: 'engagement',
    reward: 20,
    target: '/diary',
  },
  diary_streak_7: {
    id: 'diary_streak_7',
    name: '7-Day Diary Streak',
    celebration: 'A whole week of daily entries! Your consistency is inspiring.',
    icon: '⭐',
    category: 'engagement',
    reward: 50,
    target: '/diary',
  },
  diary_streak_30: {
    id: 'diary_streak_30',
    name: '30-Day Diary Streak',
    celebration: 'An incredible 30-day streak! You\'ve made journaling a true habit.',
    icon: '🏆',
    category: 'engagement',
    reward: 100,
    target: '/diary',
  },

  // ── Health ──────────────────────────────────────────────────
  first_health_check: {
    id: 'first_health_check',
    name: 'First Health Check',
    celebration: 'You completed your first health check! Knowledge is power.',
    icon: '💚',
    category: 'health',
    reward: 25,
    target: '/health',
  },

  // ── Creator ─────────────────────────────────────────────────
  first_referral: {
    id: 'first_referral',
    name: 'First Successful Referral',
    celebration: 'Someone joined through your invite! You\'re growing the community.',
    icon: '🎯',
    category: 'social',
    reward: 0, // Referral reward handled separately by AP-0405
    target: '/invite',
  },
};

// =============================================================================
// Milestone State — tracks which milestones a user has achieved
// =============================================================================

/**
 * Get the set of milestones a user has already achieved.
 * Stored as a JSONB array in autopilot_recommendations metadata
 * with source_ref = '__milestones_achieved'.
 */
async function getAchievedMilestones(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
): Promise<Set<string>> {
  const { data } = await repo.fetchAchievedMilestoneRefs(supabase, userId);

  return new Set((data || []).map((r: any) => r.source_ref));
}

/**
 * Record a milestone as achieved by inserting a completed recommendation.
 */
async function recordMilestone(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
  milestoneId: string,
): Promise<void> {
  const def = MILESTONES[milestoneId];
  if (!def) return;

  await repo.insertAchievedMilestone(supabase, {
    tenant_id: tenantId,
    user_id: userId,
    title: def.name,
    summary: def.celebration,
    domain: 'milestone',
    source_type: 'milestone',
    source_ref: milestoneId,
    risk_level: 'none',
    impact_score: 80,
    effort_score: 0,
    status: 'completed',
    activated_at: new Date().toISOString(),
    metadata: {
      milestone_id: milestoneId,
      category: def.category,
      reward: def.reward,
      completed_at: new Date().toISOString(),
    },
  });
}

// =============================================================================
// OASIS Event Emission
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

async function emitMilestoneEvent(
  userId: string,
  tenantId: string,
  milestoneId: string,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return;

  const { randomUUID } = await import('crypto');
  const def = MILESTONES[milestoneId];

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        id: randomUUID(),
        created_at: new Date().toISOString(),
        vtid: 'VTID-01250',
        topic: 'user.milestone.reached',
        service: 'milestone-service',
        role: 'AUTOPILOT',
        model: 'milestone-detection',
        status: 'info',
        message: `Milestone reached: ${def?.name || milestoneId}`,
        metadata: {
          user_id: userId,
          tenant_id: tenantId,
          milestone: milestoneId,
          category: def?.category,
          reward: def?.reward || 0,
        },
      }),
    });
  } catch (err) {
    console.warn(`[MilestoneService] Failed to emit event for ${milestoneId}:`, err);
  }
}

// =============================================================================
// Milestone Checkers — each returns true if the milestone is newly achieved
// =============================================================================

interface CheckContext {
  supabase: SupabaseClient;
  userId: string;
  tenantId: string;
  achieved: Set<string>;
}

async function checkProfileComplete(ctx: CheckContext): Promise<string | null> {
  if (ctx.achieved.has('profile_complete')) return null;

  const { data: user } = await repo.fetchAppUserForProfileCheck(ctx.supabase, ctx.userId);

  if (!user?.display_name || !user?.avatar_url) return null;

  const { count: interestCount } = await repo.countUserTopicProfileRows(ctx.supabase, ctx.tenantId, ctx.userId);

  if ((interestCount || 0) === 0) return null;

  return 'profile_complete';
}

async function checkFirstDiary(ctx: CheckContext): Promise<string | null> {
  if (ctx.achieved.has('first_diary')) return null;

  const { count } = await repo.countDiaryMemoryItems(ctx.supabase, ctx.userId);

  return (count || 0) >= 1 ? 'first_diary' : null;
}

async function checkConnectionMilestones(ctx: CheckContext): Promise<string | null> {
  const { count } = await repo.countConnectedRelationshipEdges(ctx.supabase, ctx.tenantId, ctx.userId);

  const connections = count || 0;

  if (connections >= 5 && !ctx.achieved.has('five_connections')) return 'five_connections';
  if (connections >= 1 && !ctx.achieved.has('first_connection')) return 'first_connection';
  return null;
}

async function checkFirstGroup(ctx: CheckContext): Promise<string | null> {
  if (ctx.achieved.has('first_group')) return null;

  const { count } = await repo.countGroupRelationshipEdges(ctx.supabase, ctx.tenantId, ctx.userId);

  return (count || 0) >= 1 ? 'first_group' : null;
}

async function checkFirstEventRsvp(ctx: CheckContext): Promise<string | null> {
  if (ctx.achieved.has('first_event_rsvp')) return null;

  const { count } = await repo.countRsvpMeetupAttendance(ctx.supabase, ctx.userId);

  return (count || 0) >= 1 ? 'first_event_rsvp' : null;
}

async function checkFirstMatchAccepted(ctx: CheckContext): Promise<string | null> {
  if (ctx.achieved.has('first_match_accepted')) return null;

  const { count } = await repo.countAcceptedDailyMatches(ctx.supabase, ctx.tenantId, ctx.userId);

  return (count || 0) >= 1 ? 'first_match_accepted' : null;
}

async function checkDiaryStreaks(ctx: CheckContext): Promise<string | null> {
  // Calculate current streak from diary entries
  const { data: entries } = await repo.fetchRecentDiaryEntryDates(ctx.supabase, ctx.userId, 35);

  if (!entries?.length) return null;

  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let checkDate = new Date(today);

  for (const entry of entries) {
    const entryDate = new Date(entry.created_at);
    entryDate.setHours(0, 0, 0, 0);

    if (entryDate.getTime() === checkDate.getTime()) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else if (checkDate.getTime() - entryDate.getTime() <= 86400000) {
      checkDate = new Date(entryDate);
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  // Return the highest unachieved streak milestone
  if (streak >= 30 && !ctx.achieved.has('diary_streak_30')) return 'diary_streak_30';
  if (streak >= 7 && !ctx.achieved.has('diary_streak_7')) return 'diary_streak_7';
  if (streak >= 3 && !ctx.achieved.has('diary_streak_3')) return 'diary_streak_3';
  return null;
}

async function checkFirstHealthCheck(ctx: CheckContext): Promise<string | null> {
  if (ctx.achieved.has('first_health_check')) return null;

  const { count } = await repo.countVitanaIndexScoreRows(ctx.supabase, ctx.userId);

  return (count || 0) >= 1 ? 'first_health_check' : null;
}

async function checkFirstReferral(ctx: CheckContext): Promise<string | null> {
  if (ctx.achieved.has('first_referral')) return null;

  const { count } = await repo.countSuccessfulReferrals(ctx.supabase, ctx.tenantId, ctx.userId);

  return (count || 0) >= 1 ? 'first_referral' : null;
}

// All checkers in priority order
const ALL_CHECKERS = [
  checkProfileComplete,
  checkFirstDiary,
  checkConnectionMilestones,
  checkFirstGroup,
  checkFirstEventRsvp,
  checkFirstMatchAccepted,
  checkDiaryStreaks,
  checkFirstHealthCheck,
  checkFirstReferral,
];

// =============================================================================
// Public API
// =============================================================================

/**
 * Scan a single user for any newly achieved milestones.
 * Returns the list of newly achieved milestone IDs.
 *
 * This is the core function — called both inline (event-driven)
 * and by the heartbeat scanner.
 */
export async function scanUserMilestones(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
): Promise<string[]> {
  const achieved = await getAchievedMilestones(supabase, userId, tenantId);
  const ctx: CheckContext = { supabase, userId, tenantId, achieved };

  const newMilestones: string[] = [];

  for (const checker of ALL_CHECKERS) {
    try {
      const result = await checker(ctx);
      if (result && !achieved.has(result)) {
        newMilestones.push(result);
        achieved.add(result); // prevent double-fire within same scan
      }
    } catch (err) {
      console.warn(`[MilestoneService] Checker failed for user ${userId.slice(0, 8)}…:`, err);
    }
  }

  // Record and emit events for all new milestones
  for (const milestoneId of newMilestones) {
    await recordMilestone(supabase, userId, tenantId, milestoneId);
    await emitMilestoneEvent(userId, tenantId, milestoneId);

    // Credit wallet reward if applicable.
    //
    // credit_wallet is best-effort — a duplicate p_source_event_id is
    // idempotent and fine to ignore. But supabase-js's .rpc() resolves
    // normally with an {error} field on a Postgres-level failure — it
    // does NOT throw — so the old empty `catch {}` here was unreachable
    // for that case and the failure was completely invisible in logs
    // (AURORA-B3-RPC-PARITY-INVENTORY.md's 2026-08-29 addendum). Checking
    // `error` explicitly makes it loud, per this codebase's own "never
    // silence errors" rule, without changing whether the milestone is
    // recorded (that stays a product decision, not fixed here).
    const def = MILESTONES[milestoneId];
    if (def && def.reward > 0) {
      try {
        const { error: walletErr } = await repo.creditWalletForMilestone(supabase, {
          p_tenant_id: tenantId,
          p_user_id: userId,
          p_amount: def.reward,
          p_type: 'reward',
          p_source: 'milestone',
          p_source_event_id: `milestone_${milestoneId}_${userId}`,
          p_description: def.celebration,
        });
        if (walletErr) {
          console.error(`[MilestoneService] credit_wallet RPC returned an error for ${milestoneId}: ${walletErr.message}`);
        }
      } catch (walletErr: any) {
        // Network-layer failure (the only case .rpc() actually rejects for).
        console.warn(`[MilestoneService] credit_wallet failed for ${milestoneId}: ${walletErr?.message ?? walletErr}`);
      }
    }
  }

  if (newMilestones.length > 0) {
    console.log(`[MilestoneService] User ${userId.slice(0, 8)}… achieved: ${newMilestones.join(', ')}`);
  }

  return newMilestones;
}

/**
 * Quick milestone check for a specific category.
 * Useful for inline checks after specific actions (e.g., after diary save).
 */
export async function checkMilestonesForAction(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
  action: 'diary_saved' | 'match_accepted' | 'group_joined' | 'event_rsvp' | 'profile_updated' | 'referral_completed' | 'health_checked',
): Promise<string[]> {
  const achieved = await getAchievedMilestones(supabase, userId, tenantId);
  const ctx: CheckContext = { supabase, userId, tenantId, achieved };

  // Only run relevant checkers based on the action
  const relevantCheckers: Array<(ctx: CheckContext) => Promise<string | null>> = [];

  switch (action) {
    case 'diary_saved':
      relevantCheckers.push(checkFirstDiary, checkDiaryStreaks);
      break;
    case 'match_accepted':
      relevantCheckers.push(checkFirstMatchAccepted);
      break;
    case 'group_joined':
      relevantCheckers.push(checkFirstGroup);
      break;
    case 'event_rsvp':
      relevantCheckers.push(checkFirstEventRsvp);
      break;
    case 'profile_updated':
      relevantCheckers.push(checkProfileComplete);
      break;
    case 'referral_completed':
      relevantCheckers.push(checkFirstReferral);
      break;
    case 'health_checked':
      relevantCheckers.push(checkFirstHealthCheck);
      break;
  }

  const newMilestones: string[] = [];

  for (const checker of relevantCheckers) {
    try {
      const result = await checker(ctx);
      if (result && !achieved.has(result)) {
        newMilestones.push(result);
        achieved.add(result);
      }
    } catch (err) {
      console.warn(`[MilestoneService] Checker failed:`, err);
    }
  }

  // Record and emit
  for (const milestoneId of newMilestones) {
    await recordMilestone(supabase, userId, tenantId, milestoneId);
    await emitMilestoneEvent(userId, tenantId, milestoneId);

    // See the identical wallet-credit block above (scanUserMilestones) for
    // why `error` is checked explicitly rather than relying on `catch`.
    const def = MILESTONES[milestoneId];
    if (def && def.reward > 0) {
      try {
        const { error: walletErr } = await repo.creditWalletForMilestone(supabase, {
          p_tenant_id: tenantId,
          p_user_id: userId,
          p_amount: def.reward,
          p_type: 'reward',
          p_source: 'milestone',
          p_source_event_id: `milestone_${milestoneId}_${userId}`,
          p_description: def.celebration,
        });
        if (walletErr) {
          console.error(`[MilestoneService] credit_wallet RPC returned an error for ${milestoneId}: ${walletErr.message}`);
        }
      } catch (walletErr: any) {
        console.warn(`[MilestoneService] credit_wallet failed for ${milestoneId}: ${walletErr?.message ?? walletErr}`);
      }
    }
  }

  return newMilestones;
}

/**
 * Get a user's milestone progress summary.
 */
export async function getMilestoneProgress(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
): Promise<{
  achieved: string[];
  total: number;
  remaining: string[];
}> {
  const achieved = await getAchievedMilestones(supabase, userId, tenantId);
  const allIds = Object.keys(MILESTONES);
  const remaining = allIds.filter(id => !achieved.has(id));

  return {
    achieved: [...achieved],
    total: allIds.length,
    remaining,
  };
}
