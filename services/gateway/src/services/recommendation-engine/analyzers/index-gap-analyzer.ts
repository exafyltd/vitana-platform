/**
 * Index Gap Analyzer (G5).
 *
 * Reads `vitana_pillar_agent_outputs` (the 5 pillar agents' daily
 * sub-score output) and emits CommunityUserSignal-shaped signals for
 * missing sub-scores so the Autopilot queue can surface them:
 *
 *   - subscore.baseline === 0  →  "Take the 5-question baseline survey"
 *   - subscore.data === 0      →  "Open Log Data for <pillar>"
 *   - subscore.streak < 7 AND completions > 0 → "Start a 3-day streak on <pillar>"
 *
 * Additionally — **mental-specific community signal**: when the Mental
 * pillar's `completions` sub-score is < 10 in the last 7 days, emit a
 * community-engagement signal (engage_matches / engage_meetup /
 * deepen_connection / invite_friend) that the user hasn't completed
 * recently. This is where the "community engagement = mental health"
 * principle becomes a concrete nudge.
 *
 * When the autopilot queue for a pillar is empty, fall back to
 * PILLAR_ACTION_TEMPLATES (the same templates `create_index_improvement_plan`
 * uses for voice plans — single source, two surfaces).
 *
 * All emitted signals carry a dense contribution_vector on the target
 * pillar so the G4 ranker floats them automatically.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import type { CommunityUserSignal } from './community-user-analyzer';
import { PILLAR_KEYS, PILLAR_ACTION_TEMPLATES, type PillarKey } from '../../../lib/vitana-pillars';

export interface IndexGapAnalysisResult {
  ok: boolean;
  signals: CommunityUserSignal[];
  error?: string;
}

const PILLAR_FEATURE_KEY: Record<PillarKey, string> = {
  nutrition: 'meal_log',
  hydration: 'water_intake',
  exercise:  'wearable_steps',
  sleep:     'wearable_sleep_duration',
  mental:    'meditation_minutes',
};

// Community source_refs to rotate through when the Mental pillar's
// completions sub-score is low — picks the first one the user has
// NOT completed in the last 7 days.
const MENTAL_COMMUNITY_SOURCE_REFS = [
  'engage_meetup',
  'deepen_connection',
  'engage_matches',
  'invite_friend',
  'try_live_room',
  'onboarding_maxina',
] as const;

interface PillarAgentOutputRow {
  pillar: string;
  subscore_baseline: number;
  subscore_completions: number;
  subscore_data: number;
  subscore_streak: number;
}

export async function analyzeIndexGaps(
  userId: string,
  supabase: SupabaseClient,
): Promise<IndexGapAnalysisResult> {
  try {
    // Latest pillar-agent output per pillar.
    const { data, error } = await supabase
      .from('vitana_pillar_agent_outputs')
      .select('pillar, subscore_baseline, subscore_completions, subscore_data, subscore_streak, date')
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .limit(20);
    if (error) return { ok: false, signals: [], error: error.message };

    const rows = (data ?? []) as (PillarAgentOutputRow & { date: string })[];

    // Dedup to the most recent row per pillar.
    const latestByPillar = new Map<PillarKey, PillarAgentOutputRow>();
    for (const r of rows) {
      const pk = r.pillar as PillarKey;
      if (!PILLAR_KEYS.includes(pk)) continue;
      if (!latestByPillar.has(pk)) latestByPillar.set(pk, r);
    }

    const signals: CommunityUserSignal[] = [];

    for (const p of PILLAR_KEYS) {
      const out = latestByPillar.get(p);
      if (!out) continue;

      // baseline gap
      if (out.subscore_baseline === 0) {
        // One-off — bootstrap_baseline is a set-once action. Skip if already
        // emitted in a prior run; the generator's fingerprint dedup prevents
        // duplicates across days.
        signals.push({
          title: 'Take the 5-question baseline',
          summary: 'Anchor your Vitana Index. Quick survey — it takes under 2 minutes and gives every pillar a starting value.',
          domain: 'health',
          priority: 'high',
          impact_score: 9,
          effort_score: 1,
          time_estimate_seconds: 120,
          signal_type: 'onboarding_health',
          source_detail: `index_gap:baseline:${p}`,
        });
      }

      // data gap (only emit per-pillar when the pillar has no connected data)
      if (out.subscore_data === 0) {
        signals.push({
          title: `Log data for ${capitalize(p)}`,
          summary: `Your ${capitalize(p)} pillar has no connected data source yet. Open Log Data and add a ${PILLAR_FEATURE_KEY[p]} entry — one entry gets the data sub-score off 0.`,
          domain: 'health',
          priority: 'medium',
          impact_score: 7,
          effort_score: 2,
          time_estimate_seconds: 120,
          signal_type: 'engage_health',
          source_detail: `index_gap:data:${p}`,
        });
      }

      // streak gap — only when user has some completions but no streak yet.
      if (out.subscore_streak < 7 && out.subscore_completions > 0) {
        signals.push({
          title: `Start a 3-day streak on ${capitalize(p)}`,
          summary: `You've done a few ${capitalize(p)} actions — a 3-day run compounds into a real streak bonus. Tomorrow, repeat what you did today.`,
          domain: 'health',
          priority: 'medium',
          impact_score: 6,
          effort_score: 2,
          time_estimate_seconds: 60,
          signal_type: 'start_streak',
          source_detail: `index_gap:streak:${p}`,
        });
      }
    }

    // Mental-specific community nudge: low completions on Mental → rotate
    // through community source_refs, picking the first not completed in 7 days.
    const mentalOut = latestByPillar.get('mental');
    if (mentalOut && mentalOut.subscore_completions < 10) {
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data: recent } = await supabase
        .from('calendar_events')
        .select('source_ref, source_ref_id')
        .eq('user_id', userId)
        .eq('completion_status', 'completed')
        .gte('completed_at', since);
      const completedRefs = new Set<string>(
        ((recent ?? []) as { source_ref?: string | null }[])
          .map(r => r.source_ref ?? '')
          .filter(s => s.length > 0),
      );

      const nextSource = MENTAL_COMMUNITY_SOURCE_REFS.find(sr => !completedRefs.has(sr));
      if (nextSource) {
        signals.push({
          title: communityNudgeTitle(nextSource),
          summary: communityNudgeSummary(nextSource),
          domain: 'community',
          priority: 'high',
          impact_score: 9,
          effort_score: 2,
          time_estimate_seconds: 900,
          signal_type: nextSource,
          source_detail: `index_gap:mental_community:${nextSource}`,
        });
      }
    }

    // Pillar-template fallback: when the user's pillar has a low score AND
    // neither the community analyzer nor the weakness path would produce a
    // rec (no completions, no data), emit one templated self-contained
    // action from PILLAR_ACTION_TEMPLATES for that pillar. Single-source
    // parity with create_index_improvement_plan.
    for (const p of PILLAR_KEYS) {
      const out = latestByPillar.get(p);
      if (!out) continue;
      const total = out.subscore_baseline + out.subscore_completions + out.subscore_data + out.subscore_streak;
      if (total > 60) continue;  // healthy enough
      const template = PILLAR_ACTION_TEMPLATES[p][0];
      signals.push({
        title: template.title,
        summary: `${template.description} (Auto-added because your ${capitalize(p)} pillar has the least signal right now.)`,
        domain: p === 'mental' ? 'community' : 'health',
        priority: 'medium',
        impact_score: 7,
        effort_score: 2,
        time_estimate_seconds: 900,
        signal_type: `pillar_template_${p}`,
        source_detail: `index_gap:template:${p}`,
      });
    }

    return { ok: true, signals };
  } catch (err: any) {
    return { ok: false, signals: [], error: err?.message ?? 'UNKNOWN' };
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function communityNudgeTitle(source: string): string {
  switch (source) {
    case 'engage_meetup': return 'Attend a meetup';
    case 'deepen_connection': return 'Deepen a connection';
    case 'engage_matches': return 'Respond to a match';
    case 'invite_friend': return 'Invite a friend into Vitana';
    case 'try_live_room': return 'Try a live room';
    case 'onboarding_maxina': return 'Have a chat with Maxina';
    default: return 'Community moment';
  }
}

function communityNudgeSummary(source: string): string {
  const base = 'Your Mental pillar is low on completions — community actions count as Mental-pillar practice as much as meditation does. Book chapter 09 explains the link.';
  switch (source) {
    case 'engage_meetup': return `${base} A meetup in the next three days is one of the single highest-lift actions for Mental.`;
    case 'deepen_connection': return `${base} One real conversation with someone you already know moves the pillar more than five shallow ones.`;
    case 'engage_matches': return `${base} Matches are the fastest on-ramp to new connections — reply to one.`;
    case 'invite_friend': return `${base} Inviting someone in deepens both your investment and your support network.`;
    case 'try_live_room': return `${base} A live room is a low-commitment social event — drop in for 10 minutes.`;
    case 'onboarding_maxina': return `${base} A short chat with Maxina counts as a connection check-in.`;
    default: return base;
  }
}
