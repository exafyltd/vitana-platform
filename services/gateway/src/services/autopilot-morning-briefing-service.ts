/**
 * Autopilot Morning Briefing Service
 *
 * Maxina's voice — a deeply personal, inspirational morning message that draws
 * from everything Autopilot knows about the user: their memory garden, diary
 * moods, health journey, goals, relationships, positive signals, and community
 * engagement. Each message is crafted to inspire, uplift, and gently invite
 * the user to grow alongside their community.
 *
 * Philosophy:
 *   - Speak as a caring companion who truly knows this person
 *   - Celebrate progress, however small
 *   - Acknowledge struggles with warmth, never judgment
 *   - Weave community connection in naturally — belonging fuels longevity
 *   - Every morning is a fresh page in their story
 *
 * All generation is deterministic and template-based (no LLM calls).
 * Falls back gracefully if data is sparse.
 */

import { SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// Types
// =============================================================================

interface UserMorningContext {
  user_id: string;
  first_name: string | null;

  // Health journey
  health_total: number | null;
  health_trend: 'rising' | 'dipping' | 'steady' | null;
  strongest_pillar: { name: string; score: number } | null;
  pillar_needing_love: { name: string; score: number } | null;

  // Inner life — diary & mood
  recent_mood: string | null;
  recent_energy: number | null; // 1-10
  diary_streak: number;

  // Memory garden — goals, beliefs, habits
  active_goal: string | null;
  recent_habit: string | null;
  positive_belief: string | null;

  // Predictive signals
  positive_momentum: boolean;
  social_withdrawal: boolean;

  // Relationships & community
  strong_connection_name: string | null;
  days_since_community: number | null; // days since last group/meetup/live-room activity
  group_count: number;
  upcoming_meetups: number;
  community_has_new_members: boolean;

  // Opportunities & matches
  top_match_name: string | null;
  opportunity_title: string | null;

  // Account maturity
  days_on_platform: number;
}

export interface MorningBriefingMessage {
  title: string;
  body: string;
  data: Record<string, string>;
}

// =============================================================================
// Context Gathering — pull deep personal data in parallel
// =============================================================================

export async function gatherMorningContext(
  userId: string,
  tenantId: string,
  supabase: SupabaseClient<any, any, any>,
): Promise<UserMorningContext> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [
    profileRes,
    healthTodayRes,
    healthYesterdayRes,
    diaryRecentRes,
    diaryStreakRes,
    goalsRes,
    habitsRes,
    beliefsRes,
    momentumRes,
    withdrawalRes,
    strongConnectionRes,
    communityActivityRes,
    groupCountRes,
    meetupRes,
    newMembersRes,
    matchRes,
    opportunityRes,
    accountRes,
  ] = await Promise.all([
    // ── Identity ──
    supabase
      .from('app_users')
      .select('display_name, created_at')
      .eq('user_id', userId)
      .maybeSingle(),

    // ── Health scores ──
    supabase
      .from('vitana_index_scores')
      .select('score_total, score_sleep, score_nutrition, score_exercise, score_hydration, score_mental')
      .eq('user_id', userId)
      .eq('date', today)
      .maybeSingle(),

    supabase
      .from('vitana_index_scores')
      .select('score_total')
      .eq('user_id', userId)
      .eq('date', yesterday)
      .maybeSingle(),

    // ── Recent diary mood & energy ──
    supabase
      .from('memory_diary_entries')
      .select('mood, energy_level')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .order('entry_date', { ascending: false })
      .limit(1),

    // ── Diary streak (last 60 days) ──
    supabase
      .from('memory_diary_entries')
      .select('entry_date')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .order('entry_date', { ascending: false })
      .limit(60),

    // ── Memory garden: active goals ──
    supabase
      .from('memory_garden_nodes')
      .select('title')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('node_type', 'goal')
      .gte('confidence', 50)
      .order('last_seen', { ascending: false })
      .limit(1),

    // ── Memory garden: recent habits ──
    supabase
      .from('memory_garden_nodes')
      .select('title')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('node_type', 'habit')
      .gte('confidence', 50)
      .order('last_seen', { ascending: false })
      .limit(1),

    // ── Memory garden: positive beliefs ──
    supabase
      .from('memory_garden_nodes')
      .select('title')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('node_type', 'belief')
      .gte('confidence', 40)
      .order('last_seen', { ascending: false })
      .limit(1),

    // ── Positive momentum signal (last 7 days) ──
    supabase
      .from('d44_predictive_signals')
      .select('id')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('signal_type', 'positive_momentum')
      .eq('status', 'active')
      .gte('created_at', weekAgo)
      .limit(1),

    // ── Social withdrawal signal ──
    supabase
      .from('d44_predictive_signals')
      .select('id')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('signal_type', 'social_withdrawal')
      .eq('status', 'active')
      .limit(1),

    // ── Strongest relationship (for "someone cares" nudge) ──
    supabase
      .from('relationship_edges')
      .select('relationship_nodes!to_node_id(label)')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('relationship_type', 'friend')
      .gte('strength', 60)
      .order('strength', { ascending: false })
      .limit(1),

    // ── Days since last community activity ──
    supabase
      .from('relationship_edges')
      .select('last_seen')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .in('relationship_type', ['member', 'attendee'])
      .order('last_seen', { ascending: false })
      .limit(1),

    // ── Group membership count ──
    supabase
      .from('relationship_edges')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('relationship_type', 'member'),

    // ── Upcoming meetups today ──
    supabase
      .from('community_meetup_attendance')
      .select('meetup_id, community_meetups!inner(starts_at, title)')
      .eq('user_id', userId)
      .eq('status', 'rsvp')
      .gte('community_meetups.starts_at', `${today}T00:00:00Z`)
      .lte('community_meetups.starts_at', `${today}T23:59:59Z`),

    // ── New community members this week (community growth signal) ──
    supabase
      .from('app_users')
      .select('user_id', { count: 'exact', head: true })
      .gte('created_at', weekAgo),

    // ── Today's top match ──
    supabase
      .from('user_match_results')
      .select('id, match_targets(display_name)')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .gte('created_at', `${today}T00:00:00Z`)
      .order('score', { ascending: false })
      .limit(1),

    // ── Active contextual opportunity ──
    supabase
      .from('contextual_opportunities')
      .select('title')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .order('confidence', { ascending: false })
      .limit(1),

    // ── Account creation date (for maturity) ──
    supabase
      .from('app_users')
      .select('created_at')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  // ── Derive health trend ──
  const todayTotal = healthTodayRes.data?.score_total ?? null;
  const yesterdayTotal = healthYesterdayRes.data?.score_total ?? null;
  let healthTrend: 'rising' | 'dipping' | 'steady' | null = null;
  if (todayTotal !== null && yesterdayTotal !== null) {
    const diff = todayTotal - yesterdayTotal;
    healthTrend = diff >= 10 ? 'rising' : diff <= -10 ? 'dipping' : 'steady';
  }

  // ── Find strongest & weakest pillar ──
  let strongest: { name: string; score: number } | null = null;
  let needsLove: { name: string; score: number } | null = null;
  if (healthTodayRes.data) {
    const pillars: Array<{ name: string; score: number | null }> = [
      { name: 'sleep', score: healthTodayRes.data.score_sleep },
      { name: 'nutrition', score: healthTodayRes.data.score_nutrition },
      { name: 'movement', score: healthTodayRes.data.score_exercise },
      { name: 'hydration', score: healthTodayRes.data.score_hydration },
      { name: 'mental wellness', score: healthTodayRes.data.score_mental },
    ].filter((p) => p.score !== null) as Array<{ name: string; score: number }>;

    if (pillars.length > 0) {
      pillars.sort((a, b) => b.score - a.score);
      strongest = pillars[0];
      needsLove = pillars[pillars.length - 1];
      // Only surface weakest if meaningfully different from strongest
      if (needsLove.score >= strongest.score - 10) needsLove = null;
    }
  }

  // ── Diary streak ──
  let diaryStreak = 0;
  if (diaryStreakRes.data?.length) {
    const dates = diaryStreakRes.data
      .map((d: any) => d.entry_date as string)
      .sort()
      .reverse();
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

  // ── Days since community activity ──
  let daysSinceCommunity: number | null = null;
  if (communityActivityRes.data?.[0]?.last_seen) {
    const lastSeen = new Date(communityActivityRes.data[0].last_seen);
    daysSinceCommunity = Math.floor((Date.now() - lastSeen.getTime()) / 86_400_000);
  }

  // ── Days on platform ──
  let daysOnPlatform = 0;
  const createdAt = accountRes.data?.created_at || profileRes.data?.created_at;
  if (createdAt) {
    daysOnPlatform = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000);
  }

  return {
    user_id: userId,
    first_name: profileRes.data?.display_name?.split(' ')[0] ?? null,
    health_total: todayTotal,
    health_trend: healthTrend,
    strongest_pillar: strongest,
    pillar_needing_love: needsLove,
    recent_mood: diaryRecentRes.data?.[0]?.mood ?? null,
    recent_energy: diaryRecentRes.data?.[0]?.energy_level ?? null,
    diary_streak: diaryStreak,
    active_goal: goalsRes.data?.[0]?.title ?? null,
    recent_habit: habitsRes.data?.[0]?.title ?? null,
    positive_belief: beliefsRes.data?.[0]?.title ?? null,
    positive_momentum: (momentumRes.data?.length ?? 0) > 0,
    social_withdrawal: (withdrawalRes.data?.length ?? 0) > 0,
    strong_connection_name: (strongConnectionRes.data?.[0] as any)?.relationship_nodes?.label ?? null,
    days_since_community: daysSinceCommunity,
    group_count: groupCountRes.count ?? 0,
    upcoming_meetups: meetupRes.data?.length ?? 0,
    community_has_new_members: (newMembersRes.count ?? 0) > 0,
    top_match_name: (matchRes.data?.[0] as any)?.match_targets?.display_name ?? null,
    opportunity_title: opportunityRes.data?.[0]?.title ?? null,
    days_on_platform: daysOnPlatform,
  };
}

// =============================================================================
// Message Composition — Maxina's voice
// =============================================================================

function dayIndex(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  return Math.floor((now.getTime() - start.getTime()) / 86_400_000);
}

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length];
}

/**
 * Compose a deeply personal morning message.
 *
 * Structure:
 *   1. Warm, personal greeting (title)
 *   2. Opening — acknowledge where they are emotionally/physically
 *   3. Heart — celebrate progress, reference their goals/beliefs/habits
 *   4. Gentle nudge — community connection, invitation to grow together
 *   5. Closing — uplifting send-off
 */
export function composeMorningBriefing(ctx: UserMorningContext): MorningBriefingMessage {
  const day = dayIndex();
  const name = ctx.first_name;

  // ── TITLE — warm, varied, personal ──
  const title = composeTitle(name, ctx, day);

  // ── BODY — 2-4 sentences, like a note from a friend ──
  const parts: string[] = [];

  // Opening: acknowledge their state
  parts.push(composeOpening(ctx, day));

  // Heart: celebrate + reference their journey
  const heart = composeHeart(ctx, day);
  if (heart) parts.push(heart);

  // Community: gentle, natural invitation to belong
  const community = composeCommunityNudge(ctx, day);
  if (community) parts.push(community);

  // Closing: uplifting send-off
  parts.push(composeClosing(ctx, day));

  return {
    title,
    body: parts.join(' '),
    data: { url: '/dashboard' },
  };
}

// ── Title ──

function composeTitle(name: string | null, ctx: UserMorningContext, day: number): string {
  // Milestone titles take priority
  if (ctx.days_on_platform === 0) return name ? `Welcome to your journey, ${name}` : 'Welcome to your journey';
  if (ctx.days_on_platform === 7) return name ? `One week together, ${name}!` : 'One week together!';
  if (ctx.days_on_platform === 30) return name ? `A whole month, ${name}!` : 'A whole month together!';
  if (ctx.days_on_platform === 365) return name ? `One year of growing, ${name}!` : 'One year of growing!';
  if (ctx.diary_streak >= 30) return name ? `${ctx.diary_streak} days strong, ${name}` : `${ctx.diary_streak} days strong`;
  if (ctx.positive_momentum) return name ? `You're glowing, ${name}` : 'You\'re glowing today';

  const titles = name
    ? [
      `Good morning, ${name}`,
      `A new day for you, ${name}`,
      `Here for you, ${name}`,
      `Today is yours, ${name}`,
      `Rise gently, ${name}`,
      `The world needs your light, ${name}`,
      `Another beautiful chapter, ${name}`,
    ]
    : [
      'Good morning, beautiful soul',
      'A new day is calling',
      'Today is full of possibility',
      'The morning is yours',
      'Rise gently into today',
      'Another page in your story',
      'Today holds something good',
    ];

  return pick(titles, day);
}

// ── Opening: meet them where they are ──

function composeOpening(ctx: UserMorningContext, day: number): string {
  // If we know their mood or energy from last diary entry
  if (ctx.recent_energy !== null && ctx.recent_energy <= 3) {
    return pick([
      'I noticed your energy has been low lately. It\'s okay — some mornings are for being gentle with yourself.',
      'Yesterday felt heavy, and that\'s alright. Today doesn\'t have to be perfect, it just has to be yours.',
      'You\'ve been carrying a lot. Take a breath. This morning is a chance to set things down for a moment.',
    ], day);
  }

  if (ctx.recent_energy !== null && ctx.recent_energy >= 8) {
    return pick([
      'You\'ve been radiating energy lately, and it shows in everything you\'re doing.',
      'That spark I\'m seeing in you? It\'s contagious. Bring it into today.',
      'Your energy is beautiful right now. Let\'s channel it into something meaningful today.',
    ], day);
  }

  if (ctx.recent_mood) {
    const moodLower = ctx.recent_mood.toLowerCase();
    if (['happy', 'grateful', 'joyful', 'excited', 'content', 'peaceful'].some((m) => moodLower.includes(m))) {
      return pick([
        'I love seeing the joy in your recent reflections. That light in you? It\'s real.',
        'Your positivity has been shining through. Hold onto that feeling today.',
      ], day);
    }
    if (['anxious', 'worried', 'stressed', 'overwhelmed'].some((m) => moodLower.includes(m))) {
      return pick([
        'I know things have felt overwhelming. But you\'re still here, still showing up. That matters more than you know.',
        'Anxiety has a way of lying to us about what\'s ahead. Right now, in this moment, you\'re safe and you\'re enough.',
      ], day);
    }
    if (['sad', 'lonely', 'down', 'tired'].some((m) => moodLower.includes(m))) {
      return pick([
        'Some days are harder than others, and that\'s okay. You don\'t have to have it all figured out today.',
        'I see you, even on the quieter days. You\'re not alone in this, even when it feels that way.',
      ], day);
    }
  }

  // Health-based opening
  if (ctx.health_trend === 'rising') {
    return pick([
      'Something beautiful is happening — your body is responding to the care you\'ve been giving it.',
      'Your health has been quietly climbing, and I want you to notice that. You\'re doing this.',
    ], day);
  }

  if (ctx.health_trend === 'dipping') {
    return pick([
      'Your body has been asking for a little more attention lately. Today is a wonderful day to listen.',
      'A dip in your scores isn\'t a failure — it\'s your body\'s way of saying "take care of me." And you will.',
    ], day);
  }

  // General openings
  return pick([
    'Every morning is a quiet invitation to begin again. I\'m glad you\'re here.',
    'The fact that you\'re starting your day with intention already sets you apart.',
    'Another sunrise, another chance to take one small step toward the life you\'re building.',
    'Before the day gets busy, take a breath. This moment belongs to you.',
  ], day);
}

// ── Heart: celebrate progress, reference their journey ──

function composeHeart(ctx: UserMorningContext, day: number): string | null {
  const options: string[] = [];

  // Positive momentum celebration
  if (ctx.positive_momentum) {
    options.push(pick([
      'Autopilot has noticed real positive momentum in your life recently. That\'s not luck — that\'s you, choosing to grow every single day.',
      'There\'s a pattern forming, and it\'s a beautiful one. Your consistency is creating real change.',
    ], day));
  }

  // Goal reference
  if (ctx.active_goal) {
    options.push(pick([
      `Remember your goal: "${ctx.active_goal}." Every morning you wake up with that intention, you move closer.`,
      `"${ctx.active_goal}" — that\'s what you\'re working toward. Today is another step on that path.`,
    ], day));
  }

  // Habit celebration
  if (ctx.recent_habit) {
    options.push(pick([
      `I see you building the habit of ${ctx.recent_habit.toLowerCase()}. Small rituals like that are how lasting change happens.`,
      `Your commitment to ${ctx.recent_habit.toLowerCase()} hasn\'t gone unnoticed. That\'s the kind of thing that compounds over time.`,
    ], day));
  }

  // Belief/value affirmation
  if (ctx.positive_belief) {
    options.push(
      `Something you shared with me stays with me: "${ctx.positive_belief}." Carry that into today.`,
    );
  }

  // Strongest pillar celebration
  if (ctx.strongest_pillar && ctx.strongest_pillar.score >= 60) {
    options.push(pick([
      `Your ${ctx.strongest_pillar.name} has been your superpower lately. That foundation makes everything else possible.`,
      `There\'s real strength in your ${ctx.strongest_pillar.name} right now. Build on that today.`,
    ], day));
  }

  // Pillar needing love — gentle, not judgmental
  if (ctx.pillar_needing_love && ctx.pillar_needing_love.score < 35) {
    options.push(pick([
      `Your ${ctx.pillar_needing_love.name} could use a little more love today. Even one small choice in that direction makes a difference.`,
      `I care about your ${ctx.pillar_needing_love.name} because you care about it. Maybe today holds a small moment for that.`,
    ], day));
  }

  // Diary streak
  if (ctx.diary_streak >= 7) {
    options.push(pick([
      `${ctx.diary_streak} days of showing up for yourself in your diary. That kind of self-awareness is rare and powerful.`,
      `Your ${ctx.diary_streak}-day diary streak tells me something important — you\'re someone who reflects, and that\'s how wisdom grows.`,
    ], day));
  }

  if (options.length === 0) return null;

  // Pick the most relevant one (first is usually highest signal)
  return options[0];
}

// ── Community nudge: natural, never forced ──

function composeCommunityNudge(ctx: UserMorningContext, day: number): string | null {
  // Social withdrawal detected — warm, compassionate invitation
  if (ctx.social_withdrawal) {
    if (ctx.strong_connection_name) {
      return pick([
        `I\'ve noticed you\'ve been a bit quieter lately. ${ctx.strong_connection_name} would probably love to hear from you — and sometimes a single conversation can shift the whole day.`,
        `Connection is part of longevity, and I think you know that. Maybe today is a good day to reach out to ${ctx.strong_connection_name}, even with just a hello.`,
      ], day);
    }
    return pick([
      'You\'ve been more on your own lately, and while solitude has its place, your community misses your presence. Even a small moment of connection today could mean a lot — to you and to someone else.',
      'Sometimes we pull back without realizing it. Your community is here whenever you\'re ready. No pressure, just warmth waiting for you.',
    ], day);
  }

  // Upcoming meetups — excitement
  if (ctx.upcoming_meetups > 0) {
    return pick([
      `You have a meetup today! These moments of coming together are where the magic happens. Your presence matters more than you know.`,
      `Today you get to be part of something bigger. Your meetup is a chance to grow alongside people who share your journey.`,
    ], day);
  }

  // No community engagement in a while — gentle invitation
  if (ctx.days_since_community !== null && ctx.days_since_community >= 7) {
    if (ctx.community_has_new_members) {
      return pick([
        'New people have joined the community this week — each one bringing their own story. Maybe today you\'ll cross paths with someone whose journey resonates with yours.',
        'The community has been growing, and with it, the possibilities for connection. There might be someone new who needs exactly the perspective you carry.',
      ], day);
    }
    return pick([
      'It\'s been a little while since you connected with the community. Even a quick visit can remind you that you\'re part of something meaningful.',
      'Your community is a living thing, always evolving. Pop in when you feel ready — there\'s always a seat saved for you.',
    ], day);
  }

  // Match nudge — connection as growth
  if (ctx.top_match_name) {
    return pick([
      `I found someone you might connect with — ${ctx.top_match_name}. The people in your life shape your longevity as much as any habit. This could be a meaningful one.`,
      `${ctx.top_match_name} showed up as a match for you. I don\'t surface connections randomly — there\'s something here worth exploring.`,
    ], day);
  }

  // Community growth for users not in any groups
  if (ctx.group_count === 0) {
    return pick([
      'One thing I\'ve learned: the people who thrive most on this journey are the ones who walk it with others. There are communities here that would welcome you.',
      'Longevity isn\'t a solo sport. When you\'re ready, there are groups of people here who understand exactly what you\'re building toward.',
    ], day);
  }

  // New members signal for engaged users — inspire them to welcome others
  if (ctx.community_has_new_members && ctx.group_count > 0) {
    return pick([
      'New members joined this week. Remember how it felt when you were new? A kind word from someone like you could make their whole day.',
      'The community is growing. Your experience and your story are exactly what newcomers need to see. You inspire more than you realize.',
    ], day);
  }

  return null;
}

// ── Closing: uplifting send-off ──

function composeClosing(ctx: UserMorningContext, day: number): string {
  // Opportunity teaser
  if (ctx.opportunity_title) {
    return `I also have something interesting for you today — "${ctx.opportunity_title}." Come see when you\'re ready.`;
  }

  // Context-aware closings
  if (ctx.positive_momentum) {
    return pick([
      'Keep going. What you\'re building is real, and it\'s beautiful.',
      'You\'re proof that small, consistent steps lead somewhere extraordinary.',
    ], day);
  }

  if (ctx.recent_energy !== null && ctx.recent_energy <= 3) {
    return pick([
      'Be kind to yourself today. You deserve the same gentleness you give to others.',
      'One moment at a time. That\'s all today asks of you.',
    ], day);
  }

  return pick([
    'Make today matter, even in the smallest way. I\'m here whenever you need me.',
    'I believe in the life you\'re building. Let\'s make today part of that story.',
    'You\'re not doing this alone. I\'m here, your community is here, and today is full of possibility.',
    'Go gently, go boldly, go however feels right. I\'ll be here when you get back.',
    'Today doesn\'t need to be extraordinary. It just needs to be yours. I\'m cheering for you.',
    'Whatever today brings, remember: you\'re further along than you were yesterday. And that matters.',
  ], day);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate a deeply personalized, inspiring morning briefing for a single user.
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
    // Graceful fallback — still warm
    return {
      title: 'Good morning, beautiful soul',
      body: 'Every morning is a quiet invitation to begin again. Your community is here, your journey continues, and today is full of possibility. I\'m here whenever you need me.',
      data: { url: '/dashboard' },
    };
  }
}
