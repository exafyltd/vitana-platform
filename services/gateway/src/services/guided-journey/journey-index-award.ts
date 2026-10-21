/**
 * Guided Journey — Vitana Index award for listening to a session
 * (BOOTSTRAP-GUIDED-JOURNEY-POPUP).
 *
 * Listening to a Guided Journey session earns the user +2 Vitana Index points.
 * `recordSessionListen` writes an idempotent ledger row (one per user+topic, so
 * replays never double-award). `getJourneyEngagementBonus` sums a user's awards;
 * the user-facing Vitana Index read (`fetchVitanaIndexSnapshot`) adds it on top
 * of the computed health score so the headline Index reflects the reward —
 * without polluting the stored daily health history.
 *
 * Touches ONLY `journey_session_index_awards`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const TABLE = 'journey_session_index_awards';

/** Points awarded for listening to one Guided Journey session. */
export const SESSION_INDEX_POINTS = 2;

/** Hard ceiling on the engagement overlay so it can never dominate the health
 *  score (250-topic curriculum × 2 = 500; clamp well under the 999 index max). */
export const MAX_ENGAGEMENT_BONUS = 500;

export interface AwardResult {
  /** true when THIS call created a new award (first listen of the topic). */
  awarded: boolean;
  /** Points carried by this award row. */
  points: number;
  /** The user's total engagement bonus after this call (clamped). */
  totalBonus: number;
}

/**
 * Idempotently record that a user listened to a session for `topicId`.
 * First listen of a topic inserts a +2 row; replays are no-ops for the total.
 */
export async function recordSessionListen(
  client: SupabaseClient,
  userId: string,
  topicId: string,
  points: number = SESSION_INDEX_POINTS,
): Promise<AwardResult> {
  // Insert-if-absent. ignoreDuplicates → no row returned when it already
  // existed, which is exactly how we detect a first-time award.
  const { data, error } = await client
    .from(TABLE)
    .upsert(
      { user_id: userId, topic_id: topicId, points },
      { onConflict: 'user_id,topic_id', ignoreDuplicates: true },
    )
    .select('topic_id');
  if (error) throw error;

  const awarded = Array.isArray(data) && data.length > 0;
  const totalBonus = await getJourneyEngagementBonus(client, userId);
  return { awarded, points, totalBonus };
}

/**
 * Sum a user's Guided Journey engagement bonus (clamped to MAX_ENGAGEMENT_BONUS).
 * Best-effort: returns 0 on any error so it can never break the Index read.
 */
export async function getJourneyEngagementBonus(
  client: SupabaseClient,
  userId: string,
): Promise<number> {
  if (!userId) return 0;
  try {
    const { data, error } = await client
      .from(TABLE)
      .select('points')
      .eq('user_id', userId);
    if (error || !Array.isArray(data)) return 0;
    const sum = data.reduce(
      (acc, r) => acc + (typeof (r as { points?: number }).points === 'number' ? (r as { points: number }).points : 0),
      0,
    );
    return Math.max(0, Math.min(MAX_ENGAGEMENT_BONUS, sum));
  } catch {
    return 0;
  }
}
