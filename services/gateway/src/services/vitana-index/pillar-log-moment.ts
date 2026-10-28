/**
 * VTID-05168 — a pillar log (water, sleep, workout, meditation, meal, mood)
 * becomes one `moment` on the member's timeline (catalog types `health.log.*`),
 * linked to the Index movement its recompute recorded (`movement_id`), so the
 * timeline can show the measured influence — or, when nothing moved, what it
 * counted toward. Values are written only as the catalog's allowed params.
 * Fire-and-forget: a timeline write never fails the log itself.
 */
import { writeTimelineRow } from '../timeline-projector';

export type PillarLogKind = 'meal' | 'water' | 'exercise' | 'sleep' | 'meditation' | 'mood' | 'stress';

export interface PillarLogMomentInput {
  userId: string;
  kind: PillarLogKind;
  via: 'voice' | 'manual' | 'diary';
  date: string;
  movementId?: string | null;
  params?: Record<string, string | number | null | undefined>;
  dedupeKey?: string;
}

export async function writePillarLogMoment(input: PillarLogMomentInput): Promise<void> {
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(input.params ?? {})) {
    if (v !== null && v !== undefined && v !== '') params[k] = v;
  }
  await writeTimelineRow({
    user_id: input.userId,
    activity_type: `health.log.${input.kind}`,
    activity_data: { via: input.via, date: input.date, movement_id: input.movementId ?? null, ...params },
    dedupe_key: input.dedupeKey,
    source: `projector:health_log_${input.via}`,
  }).catch(() => undefined);
}

/** Feature key → pillar log kind (the keys the Index counts, vitana_index_compute_v3). */
export const FEATURE_KEY_TO_LOG_KIND: Record<string, PillarLogKind> = {
  water_intake: 'water',
  hydration_log: 'water',
  meal_log: 'meal',
  macro_balance: 'meal',
  wearable_workout: 'exercise',
  wearable_steps: 'exercise',
  wearable_sleep_duration: 'sleep',
  meditation_minutes: 'meditation',
  mood_entry: 'mood',
  wearable_stress: 'stress',
};
