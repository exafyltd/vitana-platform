/**
 * Community User Analyzer - VTID-01185
 *
 * Per-user personalized recommendation analyzer.
 * Generates community-focused recommendations based on:
 * - Onboarding stage (day 0, 1, 3, 7, 14, 30+)
 * - Health scores & weaknesses
 * - Diary mood/energy
 * - Connection count & group memberships
 * - Pending matches
 * - Diary streak
 *
 * Unlike system-wide analyzers, this runs for a SINGLE user at a time.
 */

import { createHash } from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { detectWeaknesses, WeaknessType, HealthScores } from '../../personalization-service';

const LOG_PREFIX = '[VTID-01185:CommunityUser]';

// =============================================================================
// Types
// =============================================================================

export type OnboardingStage = 'day0' | 'day1' | 'day3' | 'day7' | 'day14' | 'day30plus';

export interface CommunityUserSignal {
  title: string;
  summary: string;
  domain: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  impact_score: number;
  effort_score: number;
  time_estimate_seconds: number;
  signal_type: string;
  source_detail: string;
}

export interface UserContext {
  userId: string;
  tenantId: string;
  userName: string | null;
  createdAt: Date;
  onboardingStage: OnboardingStage;
  healthScores: HealthScores | null;
  previousHealthScores: HealthScores | null;
  weaknesses: WeaknessType[];
  diaryMood: string | null;
  diaryEnergy: string | null;
  diaryStreak: number;
  connectionCount: number;
  groupCount: number;
  pendingMatchCount: number;
  memoryGoals: string[];
  memoryInterests: string[];
}

export interface CommunityUserAnalysisResult {
  ok: boolean;
  signals: CommunityUserSignal[];
  user_context: {
    stage: OnboardingStage;
    weaknesses: WeaknessType[];
    diary_mood: string | null;
    connection_count: number;
    diary_streak: number;
  };
  error?: string;
}

// =============================================================================
// Onboarding Stage Detection
// =============================================================================

export function detectOnboardingStage(createdAt: Date): OnboardingStage {
  const daysSinceCreation = Math.floor((Date.now() - createdAt.getTime()) / 86400000);

  if (daysSinceCreation < 1) return 'day0';
  if (daysSinceCreation < 3) return 'day1';
  if (daysSinceCreation < 7) return 'day3';
  if (daysSinceCreation < 14) return 'day7';
  if (daysSinceCreation < 30) return 'day14';
  return 'day30plus';
}

// =============================================================================
// User Context Gathering
// =============================================================================

export async function gatherUserContext(
  userId: string,
  tenantId: string,
  supabase: SupabaseClient
): Promise<UserContext> {
  // Run all queries in parallel
  const [
    healthResult,
    memoryFactsResult,
    diaryResult,
    connectionResult,
    groupResult,
    matchResult,
    userResult,
    diaryStreakResult,
  ] = await Promise.all([
    // Latest 2 health scores for trend
    supabase
      .from('vitana_index_scores')
      .select('score_total, score_physical, score_mental, score_nutritional, score_social, score_environmental')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(2),

    // Memory facts (name, goals, interests)
    supabase
      .from('memory_facts')
      .select('fact_key, fact_value')
      .eq('user_id', userId)
      .in('fact_key', ['name', 'display_name', 'goals', 'interests', 'hobbies']),

    // Recent diary entries (last 3 days for mood/energy)
    supabase
      .from('memory_items')
      .select('content, tags, metadata')
      .eq('user_id', userId)
      .eq('item_type', 'diary')
      .order('created_at', { ascending: false })
      .limit(3),

    // Connection count
    supabase
      .from('relationship_edges')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('target_type', 'person')
      .eq('relationship_type', 'connected'),

    // Group memberships
    supabase
      .from('relationship_edges')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('target_type', 'group'),

    // Pending matches
    supabase
      .from('matches_daily')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .is('feedback', null),

    // Account info
    supabase
      .from('app_users')
      .select('created_at, display_name')
      .eq('user_id', userId)
      .maybeSingle(),

    // Diary streak (consecutive days with diary entries)
    supabase
      .from('memory_items')
      .select('created_at')
      .eq('user_id', userId)
      .eq('item_type', 'diary')
      .order('created_at', { ascending: false })
      .limit(30),
  ]);

  // Parse health scores
  const healthRows = healthResult.data || [];
  const currentScores: HealthScores | null = healthRows[0] || null;
  const previousScores: HealthScores | null = healthRows[1] || null;

  // Detect weaknesses
  const weaknesses = detectWeaknesses(currentScores, previousScores);

  // Parse memory facts
  const facts = memoryFactsResult.data || [];
  const userName = facts.find((f: any) => f.fact_key === 'display_name' || f.fact_key === 'name')?.fact_value || null;
  const goals = facts.filter((f: any) => f.fact_key === 'goals').map((f: any) => f.fact_value);
  const interests = facts.filter((f: any) => f.fact_key === 'interests' || f.fact_key === 'hobbies').map((f: any) => f.fact_value);

  // Parse diary mood/energy from most recent entry
  const diaryEntries = diaryResult.data || [];
  let diaryMood: string | null = null;
  let diaryEnergy: string | null = null;
  if (diaryEntries.length > 0) {
    const latest = diaryEntries[0];
    const meta = latest.metadata as any;
    const tags = latest.tags as string[] || [];
    diaryMood = meta?.mood || tags.find((t: string) => ['happy', 'sad', 'anxious', 'calm', 'stressed', 'energetic', 'tired', 'neutral'].includes(t)) || null;
    diaryEnergy = meta?.energy || tags.find((t: string) => ['high_energy', 'low_energy', 'medium_energy'].includes(t)) || null;
  }

  // Calculate diary streak
  let diaryStreak = 0;
  const streakEntries = diaryStreakResult.data || [];
  if (streakEntries.length > 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let checkDate = new Date(today);

    for (const entry of streakEntries) {
      const entryDate = new Date(entry.created_at);
      entryDate.setHours(0, 0, 0, 0);

      if (entryDate.getTime() === checkDate.getTime()) {
        diaryStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else if (entryDate.getTime() < checkDate.getTime()) {
        // Gap found — check if yesterday
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

  // Parse user info
  const createdAt = userResult.data?.created_at ? new Date(userResult.data.created_at) : new Date();
  const displayName = userResult.data?.display_name || userName;

  return {
    userId,
    tenantId,
    userName: displayName,
    createdAt,
    onboardingStage: detectOnboardingStage(createdAt),
    healthScores: currentScores,
    previousHealthScores: previousScores,
    weaknesses,
    diaryMood,
    diaryEnergy,
    diaryStreak,
    connectionCount: connectionResult.count || 0,
    groupCount: groupResult.count || 0,
    pendingMatchCount: matchResult.count || 0,
    memoryGoals: goals,
    memoryInterests: interests,
  };
}

// =============================================================================
// Recommendation Templates
// =============================================================================

interface RecommendationTemplate {
  title: string;
  summary: string;
  domain: string;
  priority: 'low' | 'medium' | 'high';
  impact_score: number;
  effort_score: number;
  time_estimate_seconds: number;
  signal_type: string;
  condition?: (ctx: UserContext) => boolean;
}

const STAGE_TEMPLATES: Record<OnboardingStage, RecommendationTemplate[]> = {
  day0: [
    {
      title: 'Vervollständige dein Profil',
      summary: 'Ein vollständiges Profil hilft uns, dich besser zu verstehen und passende Empfehlungen zu geben.',
      domain: 'community',
      priority: 'high',
      impact_score: 9,
      effort_score: 2,
      time_estimate_seconds: 120,
      signal_type: 'onboarding_profile',
    },
    {
      title: 'Entdecke deine Community',
      summary: 'Schau dir an, wer in deiner Nähe ist und welche Gruppen es gibt.',
      domain: 'community',
      priority: 'high',
      impact_score: 8,
      effort_score: 1,
      time_estimate_seconds: 60,
      signal_type: 'onboarding_explore',
    },
    {
      title: 'Sag Hallo zu Maxina',
      summary: 'Deine KI-Begleiterin Maxina ist bereit, dich kennenzulernen. Starte ein Gespräch!',
      domain: 'community',
      priority: 'medium',
      impact_score: 7,
      effort_score: 1,
      time_estimate_seconds: 60,
      signal_type: 'onboarding_maxina',
    },
  ],
  day1: [
    {
      title: 'Schreibe deinen ersten Tagebucheintrag',
      summary: 'Halte fest, wie du dich heute fühlst. Maxina kann dir dabei helfen.',
      domain: 'health',
      priority: 'high',
      impact_score: 8,
      effort_score: 2,
      time_estimate_seconds: 120,
      signal_type: 'onboarding_diary',
      condition: (ctx) => ctx.diaryStreak === 0,
    },
    {
      title: 'Schau dir deine Matches an',
      summary: 'Wir haben passende Personen für dich gefunden. Schau mal rein!',
      domain: 'community',
      priority: 'high',
      impact_score: 8,
      effort_score: 1,
      time_estimate_seconds: 60,
      signal_type: 'onboarding_matches',
      condition: (ctx) => ctx.pendingMatchCount > 0,
    },
    {
      title: 'Tritt einer Gruppe bei',
      summary: 'Gruppen verbinden dich mit Gleichgesinnten. Finde eine, die zu dir passt.',
      domain: 'community',
      priority: 'medium',
      impact_score: 7,
      effort_score: 2,
      time_estimate_seconds: 60,
      signal_type: 'onboarding_group',
      condition: (ctx) => ctx.groupCount === 0,
    },
  ],
  day3: [
    {
      title: 'Reagiere auf deine Matches',
      summary: `Du hast noch offene Match-Vorschläge. Verbinde dich mit jemandem!`,
      domain: 'community',
      priority: 'high',
      impact_score: 8,
      effort_score: 1,
      time_estimate_seconds: 60,
      signal_type: 'engage_matches',
      condition: (ctx) => ctx.pendingMatchCount > 0,
    },
    {
      title: 'Nimm an einem Treffen teil',
      summary: 'Echte Begegnungen stärken die Gemeinschaft. Finde ein Treffen in deiner Nähe.',
      domain: 'community',
      priority: 'medium',
      impact_score: 7,
      effort_score: 3,
      time_estimate_seconds: 300,
      signal_type: 'engage_meetup',
    },
    {
      title: 'Prüfe deine Gesundheitswerte',
      summary: 'Dein Vitana-Index gibt dir einen Überblick über dein Wohlbefinden.',
      domain: 'health',
      priority: 'medium',
      impact_score: 7,
      effort_score: 1,
      time_estimate_seconds: 60,
      signal_type: 'engage_health',
      condition: (ctx) => ctx.healthScores === null,
    },
  ],
  day7: [
    {
      title: 'Vertiefe eine Verbindung',
      summary: 'Schreibe einer deiner Verbindungen eine Nachricht. Gemeinsam geht mehr!',
      domain: 'community',
      priority: 'high',
      impact_score: 8,
      effort_score: 2,
      time_estimate_seconds: 120,
      signal_type: 'deepen_connection',
      condition: (ctx) => ctx.connectionCount > 0,
    },
    {
      title: 'Setze dir ein Gesundheitsziel',
      summary: 'Definiere ein persönliches Ziel und lass Maxina dich auf dem Weg begleiten.',
      domain: 'health',
      priority: 'medium',
      impact_score: 8,
      effort_score: 2,
      time_estimate_seconds: 120,
      signal_type: 'set_goal',
      condition: (ctx) => ctx.memoryGoals.length === 0,
    },
    {
      title: 'Lade einen Freund ein',
      summary: 'Teile Vitana mit jemandem, der davon profitieren könnte.',
      domain: 'community',
      priority: 'low',
      impact_score: 6,
      effort_score: 1,
      time_estimate_seconds: 30,
      signal_type: 'invite_friend',
    },
  ],
  day14: [
    {
      title: 'Teile dein Wissen',
      summary: 'Du hast Erfahrung, die anderen helfen kann. Starte eine Diskussion in einer Gruppe.',
      domain: 'community',
      priority: 'medium',
      impact_score: 7,
      effort_score: 3,
      time_estimate_seconds: 300,
      signal_type: 'share_expertise',
      condition: (ctx) => ctx.groupCount > 0,
    },
    {
      title: 'Starte eine Wellness-Serie',
      summary: 'Regelmäßigkeit bringt Ergebnisse. Beginne eine 7-Tage-Challenge!',
      domain: 'health',
      priority: 'high',
      impact_score: 8,
      effort_score: 3,
      time_estimate_seconds: 120,
      signal_type: 'start_streak',
      condition: (ctx) => ctx.diaryStreak < 3,
    },
  ],
  day30plus: [
    {
      title: 'Werde Mentor für Neue',
      summary: 'Deine Erfahrung ist wertvoll. Hilf neuen Mitgliedern beim Einstieg.',
      domain: 'community',
      priority: 'medium',
      impact_score: 7,
      effort_score: 3,
      time_estimate_seconds: 300,
      signal_type: 'mentor_new',
    },
    {
      title: 'Organisiere ein Treffen',
      summary: 'Bringe deine Community zusammen. Plane ein Treffen zu einem Thema, das dir wichtig ist.',
      domain: 'community',
      priority: 'medium',
      impact_score: 8,
      effort_score: 5,
      time_estimate_seconds: 300,
      signal_type: 'organize_meetup',
    },
  ],
};

// =============================================================================
// Weakness-driven Templates
// =============================================================================

const WEAKNESS_TEMPLATES: Record<string, RecommendationTemplate> = {
  movement_low: {
    title: 'Bewegung einplanen',
    summary: 'Dein Bewegungswert ist niedrig. Ein kurzer Spaziergang kann schon viel bewirken!',
    domain: 'health',
    priority: 'high',
    impact_score: 8,
    effort_score: 2,
    time_estimate_seconds: 120,
    signal_type: 'weakness_movement',
  },
  stress_high: {
    title: '2-Minuten Atemübung',
    summary: 'Dein Stresslevel ist erhöht. Probiere eine kurze Atemübung aus.',
    domain: 'health',
    priority: 'high',
    impact_score: 8,
    effort_score: 1,
    time_estimate_seconds: 120,
    signal_type: 'weakness_stress',
  },
  social_low: {
    title: 'Schreibe einer Verbindung',
    summary: 'Soziale Kontakte stärken dein Wohlbefinden. Sag jemandem Hallo!',
    domain: 'community',
    priority: 'high',
    impact_score: 7,
    effort_score: 1,
    time_estimate_seconds: 60,
    signal_type: 'weakness_social',
  },
  nutrition_low: {
    title: 'Mahlzeiten dokumentieren',
    summary: 'Dein Ernährungswert hat Potenzial. Halte heute fest, was du isst.',
    domain: 'health',
    priority: 'medium',
    impact_score: 6,
    effort_score: 2,
    time_estimate_seconds: 120,
    signal_type: 'weakness_nutrition',
  },
  sleep_declining: {
    title: 'Abendroutine einrichten',
    summary: 'Deine Schlafqualität sinkt. Eine feste Abendroutine kann helfen.',
    domain: 'health',
    priority: 'high',
    impact_score: 8,
    effort_score: 2,
    time_estimate_seconds: 120,
    signal_type: 'weakness_sleep',
  },
};

// =============================================================================
// Mood-driven Templates
// =============================================================================

function getMoodTemplates(ctx: UserContext): RecommendationTemplate[] {
  const templates: RecommendationTemplate[] = [];

  if (ctx.diaryMood === 'sad' || ctx.diaryMood === 'anxious' || ctx.diaryMood === 'stressed') {
    templates.push({
      title: 'Sprich mit Maxina',
      summary: 'Du hattest einen schwierigen Tag. Maxina ist da, um dir zuzuhören.',
      domain: 'health',
      priority: 'high',
      impact_score: 8,
      effort_score: 1,
      time_estimate_seconds: 120,
      signal_type: 'mood_support',
    });
  }

  if (ctx.diaryEnergy === 'high_energy' || ctx.diaryMood === 'energetic') {
    templates.push({
      title: 'Nutze deine Energie',
      summary: 'Du bist voller Energie! Wie wäre es mit einer Community-Aktivität?',
      domain: 'community',
      priority: 'medium',
      impact_score: 6,
      effort_score: 2,
      time_estimate_seconds: 120,
      signal_type: 'mood_energy',
    });
  }

  return templates;
}

// =============================================================================
// Streak Celebration Templates
// =============================================================================

function getStreakTemplates(ctx: UserContext): RecommendationTemplate[] {
  const templates: RecommendationTemplate[] = [];

  if (ctx.diaryStreak >= 7) {
    templates.push({
      title: `${ctx.diaryStreak}-Tage-Serie! Weiter so!`,
      summary: `Du schreibst seit ${ctx.diaryStreak} Tagen Tagebuch. Das ist großartig!`,
      domain: 'health',
      priority: 'low',
      impact_score: 5,
      effort_score: 1,
      time_estimate_seconds: 30,
      signal_type: 'streak_celebration',
    });
  } else if (ctx.diaryStreak >= 3) {
    templates.push({
      title: `${ctx.diaryStreak}-Tage-Serie! Bleib dran!`,
      summary: `Schon ${ctx.diaryStreak} Tage in Folge. Mach heute weiter!`,
      domain: 'health',
      priority: 'low',
      impact_score: 5,
      effort_score: 1,
      time_estimate_seconds: 30,
      signal_type: 'streak_continue',
    });
  }

  return templates;
}

// =============================================================================
// Fingerprint Generation
// =============================================================================

export function generateCommunityUserFingerprint(userId: string, signalType: string, title: string): string {
  return createHash('sha256')
    .update(`community:${userId}:${signalType}:${title.slice(0, 50)}`)
    .digest('hex')
    .slice(0, 16);
}

// =============================================================================
// Main Analyzer
// =============================================================================

export async function analyzeCommunityUser(
  userId: string,
  tenantId: string,
  supabase: SupabaseClient
): Promise<CommunityUserAnalysisResult> {
  try {
    console.log(`${LOG_PREFIX} Analyzing user ${userId.slice(0, 8)}...`);

    const ctx = await gatherUserContext(userId, tenantId, supabase);
    const signals: CommunityUserSignal[] = [];

    // 1. Stage-based templates
    const stageTemplates = STAGE_TEMPLATES[ctx.onboardingStage] || [];
    for (const template of stageTemplates) {
      if (template.condition && !template.condition(ctx)) continue;
      signals.push({
        title: template.title,
        summary: template.summary,
        domain: template.domain,
        priority: template.priority,
        impact_score: template.impact_score,
        effort_score: template.effort_score,
        time_estimate_seconds: template.time_estimate_seconds,
        signal_type: template.signal_type,
        source_detail: `stage:${ctx.onboardingStage}`,
      });
    }

    // 2. Weakness-driven templates
    for (const weakness of ctx.weaknesses) {
      const template = WEAKNESS_TEMPLATES[weakness];
      if (!template) continue;
      signals.push({
        title: template.title,
        summary: template.summary,
        domain: template.domain,
        priority: template.priority,
        impact_score: template.impact_score,
        effort_score: template.effort_score,
        time_estimate_seconds: template.time_estimate_seconds,
        signal_type: template.signal_type,
        source_detail: `weakness:${weakness}`,
      });
    }

    // 3. Mood-driven templates
    for (const template of getMoodTemplates(ctx)) {
      signals.push({
        title: template.title,
        summary: template.summary,
        domain: template.domain,
        priority: template.priority,
        impact_score: template.impact_score,
        effort_score: template.effort_score,
        time_estimate_seconds: template.time_estimate_seconds,
        signal_type: template.signal_type,
        source_detail: `mood:${ctx.diaryMood || 'unknown'}`,
      });
    }

    // 4. Streak templates
    for (const template of getStreakTemplates(ctx)) {
      signals.push({
        title: template.title,
        summary: template.summary,
        domain: template.domain,
        priority: template.priority,
        impact_score: template.impact_score,
        effort_score: template.effort_score,
        time_estimate_seconds: template.time_estimate_seconds,
        signal_type: template.signal_type,
        source_detail: `streak:${ctx.diaryStreak}`,
      });
    }

    // Sort by impact descending, take top 8
    signals.sort((a, b) => b.impact_score - a.impact_score);
    const topSignals = signals.slice(0, 8);

    console.log(
      `${LOG_PREFIX} User ${userId.slice(0, 8)}: stage=${ctx.onboardingStage}, ` +
      `weaknesses=${ctx.weaknesses.length}, signals=${topSignals.length}`
    );

    return {
      ok: true,
      signals: topSignals,
      user_context: {
        stage: ctx.onboardingStage,
        weaknesses: ctx.weaknesses,
        diary_mood: ctx.diaryMood,
        connection_count: ctx.connectionCount,
        diary_streak: ctx.diaryStreak,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} Error analyzing user ${userId.slice(0, 8)}:`, msg);
    return { ok: false, signals: [], user_context: { stage: 'day0', weaknesses: [], diary_mood: null, connection_count: 0, diary_streak: 0 }, error: msg };
  }
}
