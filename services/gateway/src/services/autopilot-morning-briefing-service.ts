/**
 * Autopilot Morning Briefing Service
 *
 * Generates personalized, inspiring "Good Morning" notifications for each user
 * by pulling together their health scores, active recommendations, today's matches,
 * upcoming events, and detected weaknesses — then composing a short, warm message
 * that sets a positive tone for the day.
 *
 * All message generation is deterministic and template-based (no LLM calls).
 * Respects user notification preferences and DND windows.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { WeaknessType, WEAKNESS_EXPLANATIONS } from './personalization-service';

// =============================================================================
// Types
// =============================================================================

interface UserMorningContext {
  user_id: string;
  display_name: string | null;
  health_total: number | null;
  health_trend: 'improving' | 'declining' | 'stable' | null;
  weaknesses: WeaknessType[];
  top_match_name: string | null;
  match_count: number;
  pending_recommendations: number;
  upcoming_meetups: number;
  diary_streak: number;
}

export interface MorningBriefingMessage {
  title: string;
  body: string;
  data: Record<string, string>;
}

// =============================================================================
// Inspirational greetings — rotated by day-of-year for variety
// =============================================================================

const GREETINGS: string[] = [
  'Good morning',
  'Rise and shine',
  'A new day awaits',
  'Hello, sunshine',
  'Time to shine',
  'Welcome to a fresh start',
  'A beautiful day begins',
];

const HEALTH_ENCOURAGEMENTS: Record<string, string[]> = {
  improving: [
    'Your health scores are trending up — keep the momentum going!',
    'You\'re on an upward trend — great work taking care of yourself.',
    'Your scores are climbing. Whatever you\'re doing, it\'s working!',
  ],
  declining: [
    'Your scores dipped a bit — today is a perfect day to reset.',
    'A small dip in your scores, but every new morning is a chance to bounce back.',
    'Your body may need extra care today. Be gentle with yourself.',
  ],
  stable: [
    'Your health is steady — a solid foundation to build on today.',
    'Consistency is strength. Your steady scores show real discipline.',
  ],
};

const WEAKNESS_MORNING_TIPS: Partial<Record<WeaknessType, string>> = {
  movement_low: 'A short walk this morning could set a great tone for the day.',
  sleep_declining: 'Start winding down earlier tonight — your sleep will thank you.',
  stress_high: 'Try a few deep breaths before diving into your day.',
  nutrition_low: 'A nourishing breakfast could be your superpower today.',
  social_low: 'Reaching out to someone you care about could brighten both your days.',
};

const STREAK_CELEBRATIONS: Array<{ min: number; message: string }> = [
  { min: 30, message: 'An incredible {n}-day diary streak — you\'re building a lasting habit!' },
  { min: 14, message: '{n} days of journaling! That consistency is powerful.' },
  { min: 7, message: 'A {n}-day diary streak — you\'re on a roll!' },
  { min: 3, message: '{n} days in a row journaling. Keep it up!' },
];

// =============================================================================
// Context Gathering
// =============================================================================

/**
 * Gather all user context needed to compose a personalized morning message.
 * Uses parallel queries for performance.
 */
export async function gatherMorningContext(
  userId: string,
  tenantId: string,
  supabase: SupabaseClient<any, any, any>,
): Promise<UserMorningContext> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  // Run queries in parallel
  const [profileRes, healthTodayRes, healthYesterdayRes, matchRes, recRes, meetupRes, diaryRes] =
    await Promise.all([
      // User display name
      supabase
        .from('user_profiles')
        .select('display_name')
        .eq('user_id', userId)
        .eq('tenant_id', tenantId)
        .maybeSingle(),

      // Today's health score
      supabase
        .from('vitana_index_scores')
        .select('score_total, score_physical, score_mental, score_nutritional, score_social')
        .eq('user_id', userId)
        .eq('date', today)
        .maybeSingle(),

      // Yesterday's health score (for trend)
      supabase
        .from('vitana_index_scores')
        .select('score_total')
        .eq('user_id', userId)
        .eq('date', yesterday)
        .maybeSingle(),

      // Today's matches
      supabase
        .from('user_match_results')
        .select('id, match_targets(display_name)')
        .eq('user_id', userId)
        .eq('tenant_id', tenantId)
        .gte('created_at', `${today}T00:00:00Z`)
        .order('score', { ascending: false })
        .limit(1),

      // Pending recommendations
      supabase
        .from('autopilot_recommendations')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('tenant_id', tenantId)
        .eq('status', 'new'),

      // Upcoming meetups today (user RSVPd)
      supabase
        .from('community_meetup_attendance')
        .select('meetup_id, community_meetups!inner(starts_at)')
        .eq('user_id', userId)
        .eq('status', 'rsvp')
        .gte('community_meetups.starts_at', `${today}T00:00:00Z`)
        .lte('community_meetups.starts_at', `${today}T23:59:59Z`),

      // Diary streak — count consecutive days with diary entries
      supabase
        .from('diary_entries')
        .select('entry_date')
        .eq('user_id', userId)
        .eq('tenant_id', tenantId)
        .order('entry_date', { ascending: false })
        .limit(60),
    ]);

  // Compute health trend
  let healthTrend: 'improving' | 'declining' | 'stable' | null = null;
  const todayScore = healthTodayRes.data?.score_total ?? null;
  const yesterdayScore = healthYesterdayRes.data?.score_total ?? null;
  if (todayScore !== null && yesterdayScore !== null) {
    const diff = todayScore - yesterdayScore;
    if (diff >= 10) healthTrend = 'improving';
    else if (diff <= -10) healthTrend = 'declining';
    else healthTrend = 'stable';
  }

  // Detect weaknesses from health dimensions
  const weaknesses: WeaknessType[] = [];
  if (healthTodayRes.data) {
    const h = healthTodayRes.data;
    if (h.score_physical !== null && h.score_physical < 40) weaknesses.push('movement_low');
    if (h.score_mental !== null && h.score_mental < 40) weaknesses.push('stress_high');
    if (h.score_nutritional !== null && h.score_nutritional < 40) weaknesses.push('nutrition_low');
    if (h.score_social !== null && h.score_social < 35) weaknesses.push('social_low');
  }

  // Compute diary streak
  let diaryStreak = 0;
  if (diaryRes.data?.length) {
    const dates = diaryRes.data.map((d: any) => d.entry_date as string).sort().reverse();
    let expected = today;
    for (const d of dates) {
      if (d === expected) {
        diaryStreak++;
        expected = new Date(new Date(expected).getTime() - 86_400_000).toISOString().slice(0, 10);
      } else if (d < expected) {
        break;
      }
    }
  }

  // Extract top match name
  const topMatchRow = matchRes.data?.[0];
  const topMatchName = (topMatchRow as any)?.match_targets?.display_name ?? null;

  return {
    user_id: userId,
    display_name: profileRes.data?.display_name ?? null,
    health_total: todayScore,
    health_trend: healthTrend,
    weaknesses,
    top_match_name: topMatchName,
    match_count: matchRes.data?.length ?? 0,
    pending_recommendations: recRes.count ?? 0,
    upcoming_meetups: meetupRes.data?.length ?? 0,
    diary_streak: diaryStreak,
  };
}

// =============================================================================
// Message Composition
// =============================================================================

/**
 * Deterministic day-of-year index for rotating templates.
 */
function dayIndex(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  return Math.floor((now.getTime() - start.getTime()) / 86_400_000);
}

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length];
}

/**
 * Compose a personalized morning briefing message from user context.
 */
export function composeMorningBriefing(ctx: UserMorningContext): MorningBriefingMessage {
  const day = dayIndex();
  const greeting = pick(GREETINGS, day);
  const name = ctx.display_name?.split(' ')[0]; // first name only

  // Title
  const title = name ? `${greeting}, ${name}!` : `${greeting}!`;

  // Body segments
  const segments: string[] = [];

  // 1. Health insight
  if (ctx.health_trend && HEALTH_ENCOURAGEMENTS[ctx.health_trend]) {
    segments.push(pick(HEALTH_ENCOURAGEMENTS[ctx.health_trend], day));
  } else if (ctx.health_total !== null) {
    segments.push(`Your Vitana score is ${ctx.health_total} — let's make today count.`);
  }

  // 2. Weakness-based morning tip (pick the most actionable one)
  if (ctx.weaknesses.length > 0) {
    const tip = WEAKNESS_MORNING_TIPS[ctx.weaknesses[0]];
    if (tip) segments.push(tip);
  }

  // 3. Matches
  if (ctx.top_match_name) {
    segments.push(`You have a new match with ${ctx.top_match_name} — check it out!`);
  } else if (ctx.match_count > 0) {
    segments.push(`You have ${ctx.match_count} new match${ctx.match_count > 1 ? 'es' : ''} waiting for you.`);
  }

  // 4. Recommendations
  if (ctx.pending_recommendations > 0) {
    segments.push(
      ctx.pending_recommendations === 1
        ? '1 recommendation is ready for your review.'
        : `${ctx.pending_recommendations} recommendations are ready for your review.`,
    );
  }

  // 5. Upcoming meetups
  if (ctx.upcoming_meetups > 0) {
    segments.push(
      ctx.upcoming_meetups === 1
        ? 'You have a meetup scheduled today — don\'t miss it!'
        : `You have ${ctx.upcoming_meetups} meetups lined up today.`,
    );
  }

  // 6. Diary streak celebration
  if (ctx.diary_streak >= 3) {
    const celebration = STREAK_CELEBRATIONS.find((s) => ctx.diary_streak >= s.min);
    if (celebration) {
      segments.push(celebration.message.replace('{n}', String(ctx.diary_streak)));
    }
  }

  // Fallback if nothing personalized
  if (segments.length === 0) {
    segments.push('Your daily briefing is ready. See what\'s happening today.');
  }

  return {
    title,
    body: segments.join(' '),
    data: { url: '/dashboard' },
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate a personalized morning briefing for a single user.
 * Gathers context from DB and composes the message.
 */
export async function generateMorningBriefing(
  userId: string,
  tenantId: string,
  supabase: SupabaseClient<any, any, any>,
): Promise<MorningBriefingMessage> {
  try {
    const ctx = await gatherMorningContext(userId, tenantId, supabase);
    return composeMorningBriefing(ctx);
  } catch (err: any) {
    console.error(`[MorningBriefing] Failed to personalize for user=${userId.slice(0, 8)}…:`, err.message || err);
    // Graceful fallback to generic message
    return {
      title: 'Good Morning!',
      body: 'Your daily briefing is ready. See what\'s happening today.',
      data: { url: '/dashboard' },
    };
  }
}
