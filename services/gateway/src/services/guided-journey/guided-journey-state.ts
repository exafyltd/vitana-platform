/**
 * VTID-03276 — Guided Journey durable state service (P1).
 *
 * Reads/writes `user_guided_journey_state` (guided|full mode + onboarding
 * lifecycle + practice qualification). The HTTP surface (routes/guided-journey.ts)
 * is a thin delegator over these functions; tests exercise these directly with a
 * mocked Supabase client.
 *
 * INVARIANTS (enforced here, documented in the migration):
 *  - Switching mode NEVER mutates progress (current_session, completed_topic_ids,
 *    completed_practice_count, qualification) — only mode + audit timestamps move.
 *  - This service touches ONLY journey UX state. It never reads or writes
 *    subscription or feature-permission state.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  JourneyMode,
  JourneyState,
  GuidedJourneyStateRow,
} from '../../types/guided-journey';

const TABLE = 'user_guided_journey_state';

/** Map a raw DB row to the camel-cased client view. */
export function toJourneyState(row: GuidedJourneyStateRow): JourneyState {
  return {
    mode: row.mode,
    onboardingStatus: row.onboarding_status,
    currentSession: row.current_session,
    completedTopicIds: row.completed_topic_ids ?? [],
    completedPracticeCount: row.completed_practice_count,
    qualificationThreshold: row.qualification_threshold,
    qualifiedAt: row.qualified_at,
    skippedOnboardingAt: row.skipped_onboarding_at,
    enteredFullModeAt: row.entered_full_mode_at,
    returnedToGuidedAt: row.returned_to_guided_at,
    lastOpenedTopicId: row.last_opened_topic_id,
    updatedAt: row.updated_at,
  };
}

/**
 * Fetch the user's journey-state row, lazily creating a default one if absent.
 * Default mode is 'guided' (the first-time onboarding shell); the routing layer
 * (P4) decides whether an *established* user is shown guided or full — this just
 * guarantees a row exists to read/update.
 */
export async function ensureState(
  client: SupabaseClient,
  userId: string,
): Promise<GuidedJourneyStateRow> {
  const existing = await client
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing.error) throw existing.error;
  if (existing.data) return existing.data as GuidedJourneyStateRow;

  // No row yet — insert defaults. Use upsert with ignoreDuplicates so a
  // concurrent create doesn't error; then re-read the authoritative row.
  const inserted = await client
    .from(TABLE)
    .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true })
    .select('*')
    .maybeSingle();

  if (inserted.error) throw inserted.error;
  if (inserted.data) return inserted.data as GuidedJourneyStateRow;

  // Lost the insert race (ignoreDuplicates returned no row) — read the winner.
  const reread = await client
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .single();
  if (reread.error) throw reread.error;
  return reread.data as GuidedJourneyStateRow;
}

/** Full durable journey state for a user (creates the row on first read). */
export async function getJourneyState(
  client: SupabaseClient,
  userId: string,
): Promise<JourneyState> {
  return toJourneyState(await ensureState(client, userId));
}

/**
 * Switch the user between 'guided' and 'full', applying the spec's lossless
 * switch rules:
 *   → full:  stamp entered_full_mode_at once; if switching before qualifying,
 *            stamp skipped_onboarding_at once and mark status 'skipped'.
 *   → guided: stamp returned_to_guided_at; if previously 'skipped', resume as
 *            'in_progress'. Progress fields are never touched.
 */
export async function setJourneyMode(
  client: SupabaseClient,
  userId: string,
  mode: JourneyMode,
  now: string = new Date().toISOString(),
): Promise<JourneyState> {
  const row = await ensureState(client, userId);

  const patch: Record<string, unknown> = { mode, updated_at: now };

  if (mode === 'full') {
    if (!row.entered_full_mode_at) patch.entered_full_mode_at = now;
    const qualified =
      row.onboarding_status === 'qualified' || row.onboarding_status === 'completed';
    if (!qualified && !row.skipped_onboarding_at) {
      patch.skipped_onboarding_at = now;
      patch.onboarding_status = 'skipped';
    }
  } else {
    patch.returned_to_guided_at = now;
    if (row.onboarding_status === 'skipped') {
      patch.onboarding_status = 'in_progress';
    }
  }

  const updated = await client
    .from(TABLE)
    .update(patch)
    .eq('user_id', userId)
    .select('*')
    .single();

  if (updated.error) throw updated.error;
  return toJourneyState(updated.data as GuidedJourneyStateRow);
}

/**
 * BOOTSTRAP-GUIDED-JOURNEY-SESSION-PERSIST — durably record that the user
 * listened to guided session `session`.
 *
 * THE BUG THIS FIXES: the "Sitzung N" ring was driven ONLY by per-browser
 * localStorage (see useGuidedJourneyProgress.ts) — nothing was persisted
 * server-side, so the count reset whenever localStorage was cleared and
 * differed between origins (staging vs production showed different numbers
 * for the same account). We now advance `current_session` — the durable,
 * account-scoped marker — so progress survives device/browser changes.
 *
 * `current_session` is "the session the user is ON"; listening to N advances
 * to N+1. Monotonic: replaying an already-passed session never rewinds.
 */
export async function recordListenedSession(
  client: SupabaseClient,
  userId: string,
  session: number,
  now: string = new Date().toISOString(),
): Promise<JourneyState> {
  const row = await ensureState(client, userId);

  const safeSession = Number.isInteger(session) && session > 0 ? session : 1;
  // Listening to session N means the user is now on N+1. Never rewind.
  const nextCurrent = Math.max(row.current_session, safeSession + 1);

  const patch: Record<string, unknown> = { updated_at: now };
  if (nextCurrent !== row.current_session) patch.current_session = nextCurrent;
  // A not_started user who listens is now in progress.
  if (row.onboarding_status === 'not_started') patch.onboarding_status = 'in_progress';

  // Nothing actually advanced (replay of an already-passed session, status
  // already moved) — skip the write and return the current state.
  const advances = 'current_session' in patch || 'onboarding_status' in patch;
  if (!advances) return toJourneyState(row);

  const updated = await client
    .from(TABLE)
    .update(patch)
    .eq('user_id', userId)
    .select('*')
    .single();

  if (updated.error) throw updated.error;
  return toJourneyState(updated.data as GuidedJourneyStateRow);
}

/**
 * VTID-03282 (P7) — record a completed guided-practice action for a topic.
 *
 * Idempotent per topic: the first completion of a topic appends it to
 * completed_topic_ids and increments completed_practice_count; re-completing the
 * same topic is a no-op for the counter. When the count first reaches the
 * qualification threshold, the user is marked 'qualified'. A not_started user
 * who completes a practice becomes 'in_progress'. Listening alone never calls
 * this — only a real practice action does.
 */
export async function completePractice(
  client: SupabaseClient,
  userId: string,
  topicId: string,
  now: string = new Date().toISOString(),
): Promise<JourneyState> {
  const row = await ensureState(client, userId);

  const completed = new Set(row.completed_topic_ids ?? []);
  const alreadyDone = completed.has(topicId);
  completed.add(topicId);
  const newCount = alreadyDone
    ? row.completed_practice_count
    : row.completed_practice_count + 1;

  const patch: Record<string, unknown> = {
    completed_topic_ids: Array.from(completed),
    completed_practice_count: newCount,
    last_opened_topic_id: topicId,
    updated_at: now,
  };

  const terminal =
    row.onboarding_status === 'qualified' || row.onboarding_status === 'completed';
  if (!terminal && newCount >= row.qualification_threshold) {
    patch.onboarding_status = 'qualified';
    if (!row.qualified_at) patch.qualified_at = now;
  } else if (row.onboarding_status === 'not_started') {
    patch.onboarding_status = 'in_progress';
  }

  const updated = await client
    .from(TABLE)
    .update(patch)
    .eq('user_id', userId)
    .select('*')
    .single();

  if (updated.error) throw updated.error;
  return toJourneyState(updated.data as GuidedJourneyStateRow);
}
