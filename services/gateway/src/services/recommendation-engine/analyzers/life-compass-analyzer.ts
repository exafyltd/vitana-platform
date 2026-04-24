/**
 * Life Compass Analyzer (G3c)
 *
 * Reads the user's active `life_compass` row and emits a single
 * high-impact signal that biases the Autopilot queue toward the goal's
 * category. Signals are shaped like CommunityUserSignal so the generator
 * can route them through the same convertCommunityUserSignal path and
 * inherit contribution_vector, wave enrichment, and dedup.
 *
 * Two cases:
 *   (a) No active goal — emit a single `set_goal` signal (the action is
 *       already in COMMUNITY_ACTIONS; the target is patched in G3d to
 *       open the Life Compass overlay instead of a stale /health nav).
 *   (b) Active goal — emit a category-specific *boost* signal that tags
 *       a matching wave template (e.g. category `community` → boost
 *       `engage_matches`; `longevity` → boost whatever the weakest pillar
 *       is; `skills` → boost `share_expertise`). The emitted
 *       `signal_type` stays stable (matches existing COMMUNITY_ACTIONS
 *       keys) so the contribution_vector trigger maps it correctly.
 *
 * Keep this analyzer small and side-effect-free. Heavier compass-driven
 * ranking happens later in the ranker (G4), which reads the same
 * life_compass row and applies `compassBoost` to every candidate whose
 * source_ref is in the goal's preferred template set.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import type { CommunityUserSignal } from './community-user-analyzer';

export interface LifeCompassAnalysisResult {
  ok: boolean;
  signals: CommunityUserSignal[];
  active_goal: { primary_goal: string; category: string } | null;
  error?: string;
}

/**
 * Category → preferred wave-template keys. These are the existing
 * source_refs in COMMUNITY_ACTIONS (autopilot-recommendations.ts) —
 * the analyzer only emits the single most-aligned one per goal so the
 * queue stays focused. The heavier ranker in G4 will use this same
 * mapping to apply compassBoost to every candidate of those templates.
 */
const CATEGORY_TO_TEMPLATE: Record<string, { signal: string; title: string; summary: string; domain: string; impact: number }> = {
  community: {
    signal: 'engage_matches',
    title: 'Meet someone new this week',
    summary: 'Your Life Compass points at community — matches are the fastest way to deepen that.',
    domain: 'community',
    impact: 9,
  },
  connection: {
    signal: 'deepen_connection',
    title: 'Deepen a connection',
    summary: 'Your Life Compass points at connection. A short, real conversation today matters more than ten quick reactions.',
    domain: 'community',
    impact: 9,
  },
  longevity: {
    // Longevity is system-wide — emit a set_streak nudge; the ranker's
    // pillar-gap weighting will pick the weakest pillar.
    signal: 'start_streak',
    title: 'Start a streak on your weakest pillar',
    summary: 'Your Life Compass points at longevity. Daily repetition on the pillar lagging furthest behind moves the Index fastest.',
    domain: 'health',
    impact: 9,
  },
  health: {
    signal: 'start_streak',
    title: 'Start a health streak',
    summary: 'Your Life Compass points at health — momentum comes from daily micro-actions, not big pushes.',
    domain: 'health',
    impact: 9,
  },
  skills: {
    signal: 'share_expertise',
    title: 'Share what you know',
    summary: 'Your Life Compass points at skill-building. Teaching is the fastest way to consolidate what you\'re learning.',
    domain: 'community',
    impact: 9,
  },
  spiritual: {
    signal: 'onboarding_diary',
    title: 'Reflective journaling',
    summary: 'Your Life Compass points at an inner practice. A short daily reflection anchors it.',
    domain: 'health',
    impact: 9,
  },
  career: {
    // No dedicated career templates yet (Business Hub isn't live).
    // Still emit a neutral mental nudge — career stress shows up on Mental.
    signal: 'onboarding_diary',
    title: 'Check in with yourself',
    summary: 'Your Life Compass points at career. A short reflection on where the week went protects the Mental pillar.',
    domain: 'health',
    impact: 8,
  },
  finance: {
    signal: 'onboarding_diary',
    title: 'Pause and plan',
    summary: 'Your Life Compass points at finance. A short planning check-in today protects the Mental pillar.',
    domain: 'health',
    impact: 8,
  },
};

export async function analyzeLifeCompass(
  userId: string,
  supabase: SupabaseClient,
): Promise<LifeCompassAnalysisResult> {
  try {
    const { data, error } = await supabase
      .from('life_compass')
      .select('primary_goal, category')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      return { ok: false, signals: [], active_goal: null, error: error.message };
    }

    const row = Array.isArray(data) && data.length > 0
      ? (data[0] as { primary_goal: string; category: string })
      : null;

    // Case (a): no goal → nudge to set one.
    if (!row) {
      return {
        ok: true,
        signals: [{
          title: 'Set your Life Compass',
          summary: 'Pick a direction and Vitana will bias every recommendation toward it.',
          domain: 'community',
          priority: 'high',
          impact_score: 8,
          effort_score: 1,
          time_estimate_seconds: 120,
          signal_type: 'set_goal',
          source_detail: 'life_compass:not_set',
        }],
        active_goal: null,
      };
    }

    // Case (b): active goal → category-aligned signal.
    const categoryKey = (row.category || '').toLowerCase();
    const preset = CATEGORY_TO_TEMPLATE[categoryKey];
    if (!preset) {
      return { ok: true, signals: [], active_goal: { primary_goal: row.primary_goal, category: row.category } };
    }

    return {
      ok: true,
      signals: [{
        title: preset.title,
        summary: `${preset.summary} (Aligned with your goal: "${row.primary_goal}".)`,
        domain: preset.domain,
        priority: 'high',
        impact_score: preset.impact,
        effort_score: 2,
        time_estimate_seconds: 180,
        signal_type: preset.signal,
        source_detail: `life_compass:${categoryKey}`,
      }],
      active_goal: { primary_goal: row.primary_goal, category: row.category },
    };
  } catch (err: any) {
    return { ok: false, signals: [], active_goal: null, error: err?.message ?? 'UNKNOWN' };
  }
}
