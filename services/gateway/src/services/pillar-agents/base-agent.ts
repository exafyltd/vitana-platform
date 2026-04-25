/**
 * Shared helpers for pillar agents. v1 keeps the math identical to the
 * compute RPC so switching to agent outputs is a drop-in change.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PillarAnswer, PillarKey, PillarSubscores } from './types';
import { PILLAR_TAGS, pillarBookChapter } from '../../lib/vitana-pillars';

const BASELINE_CURVE: Record<1|2|3|4|5, number> = { 1: 10, 2: 20, 3: 25, 4: 32, 5: 40 };

const PILLAR_FEATURE_KEYS: Record<PillarKey, string[]> = {
  nutrition: ['biomarker_glucose', 'biomarker_hba1c', 'meal_log', 'macro_balance'],
  hydration: ['water_intake', 'hydration_log'],
  exercise:  ['wearable_heart_rate', 'wearable_steps', 'wearable_workout', 'vo2_max'],
  sleep:     ['wearable_sleep_duration', 'wearable_sleep_efficiency', 'wearable_hrv', 'wearable_sleep_stages'],
  mental:    ['wearable_stress', 'mood_entry', 'meditation_minutes', 'journal_entry'],
};

/** Baseline sub-score (max 40) from the user's baseline survey answers. */
export async function computeBaselineSubscore(
  admin: SupabaseClient,
  userId: string,
  pillar: PillarKey,
): Promise<number> {
  const { data } = await admin
    .from('vitana_index_baseline_survey')
    .select('answers')
    .eq('user_id', userId)
    .maybeSingle();
  const answer = (data?.answers as any)?.[pillar];
  const rating = Number.isInteger(answer) && answer >= 1 && answer <= 5
    ? (answer as 1|2|3|4|5)
    : null;
  return rating ? BASELINE_CURVE[rating] : 10;
}

/** Completions sub-score (max 80) from last 30d completed calendar events
 * whose wellness_tags match this pillar's tag bucket. Each match = +6. */
export async function computeCompletionsSubscore(
  admin: SupabaseClient,
  userId: string,
  pillar: PillarKey,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const { data } = await admin
    .from('calendar_events')
    .select('wellness_tags, completed_at, end_time')
    .eq('user_id', userId)
    .eq('completion_status', 'completed')
    .gte('completed_at', cutoffIso);

  const tags = new Set(PILLAR_TAGS[pillar]);
  let score = 0;
  for (const row of data ?? []) {
    const rowTags = (row.wellness_tags as string[] | null) ?? [];
    if (rowTags.some(t => tags.has(t))) score += 6;
  }
  return Math.min(score, 80);
}

/** Connected-data sub-score (max 40) based on count of pillar-relevant
 * feature rows in the last 7 days. */
export async function computeDataSubscore(
  admin: SupabaseClient,
  userId: string,
  pillar: PillarKey,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const { count } = await admin
    .from('health_features_daily')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('date', cutoffIso)
    .in('feature_key', PILLAR_FEATURE_KEYS[pillar]);

  const n = count ?? 0;
  if (n >= 11) return 40;
  if (n >= 4)  return 25;
  if (n >= 1)  return 15;
  return 0;
}

/** Streak bonus (max 40) — mirrors the vitana_pillar_streak_days() SQL
 * helper so agent output matches the RPC. */
export async function computeStreakSubscore(
  admin: SupabaseClient,
  userId: string,
  pillar: PillarKey,
): Promise<number> {
  const { data } = await admin.rpc('vitana_pillar_streak_days', {
    p_user_id: userId,
    p_pillar_key: pillar,
  });
  const days = Number(data ?? 0);
  if (days >= 30) return 40;
  if (days >= 14) return 25;
  if (days >= 7)  return 15;
  return 0;
}

export async function computeAllSubscoresForPillar(
  admin: SupabaseClient,
  userId: string,
  pillar: PillarKey,
): Promise<PillarSubscores> {
  const [baseline, completions, data, streak] = await Promise.all([
    computeBaselineSubscore(admin, userId, pillar),
    computeCompletionsSubscore(admin, userId, pillar),
    computeDataSubscore(admin, userId, pillar),
    computeStreakSubscore(admin, userId, pillar),
  ]);
  return { baseline, completions, data, streak };
}

/**
 * Default v1 implementation of `PillarAgent.answerQuestion`. Deterministic,
 * no LLM. Reads the user's current sub-scores for the pillar, identifies
 * the dominant signal source, and returns a short narrative + Book chapter
 * citation. Voice consumes `text` and weaves naturally; `data` is for
 * downstream consumers (logging, future LLM rewrap).
 *
 * Each agent's index.ts can replace this with custom logic when external
 * integrations or per-pillar narratives ship in Phase F v2+.
 */
export async function defaultPillarAnswer(
  admin: SupabaseClient,
  userId: string,
  pillar: PillarKey,
  question: string,
  agentVersion: string,
): Promise<PillarAnswer> {
  const subscores = await computeAllSubscoresForPillar(admin, userId, pillar);
  const total = subscores.baseline + subscores.completions + subscores.data + subscores.streak;
  const cap = 200;
  const score = Math.min(cap, total);

  // Dominant signal source — what's carrying this pillar's number.
  const parts: Array<[keyof PillarSubscores, number]> = [
    ['baseline', subscores.baseline],
    ['completions', subscores.completions],
    ['data', subscores.data],
    ['streak', subscores.streak],
  ];
  parts.sort((a, b) => b[1] - a[1]);
  const [topKey, topVal] = parts[0];
  const share = total > 0 ? topVal / total : 0;

  const lever: string =
    topKey === 'baseline' && share >= 0.6
      ? 'Most of the score is the survey baseline — connecting a tracker or logging your daily activity would lift it the most.'
      : topKey === 'completions' && share >= 0.4
      ? 'Completed actions are carrying the score — keep the rhythm.'
      : topKey === 'data' && share >= 0.4
      ? 'Connected data is feeding the score — real signal is stronger than survey self-rating.'
      : topKey === 'streak' && share >= 0.3
      ? 'A consistent streak is doing real work — day-over-day consistency compounds.'
      : 'Sub-scores are evenly distributed; lifting any of the four (baseline, completions, data, streak) would help.';

  const text = `Your ${pillar} pillar is at ${score} of 200. ${lever}`;
  const citation = pillarBookChapter(pillar);

  return {
    pillar,
    text,
    citations: [citation],
    data: {
      score,
      cap,
      subscores,
      dominant_subscore: topKey,
      dominant_share: Number(share.toFixed(2)),
      question_seen: question.slice(0, 200),
    },
    agent_version: agentVersion,
  };
}
