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
  AudiobookDailyListen,
  AudiobookReminderPref,
} from '../../types/guided-journey';

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Before 22:00: the dispatcher's 2-hour catch-up window must not wrap past midnight.
const REMINDER_TIME_RE = /^([01]\d|2[01]):[0-5]\d$/;

function readDailyListen(metadata: Record<string, unknown> | null): AudiobookDailyListen | null {
  const raw = metadata?.daily_listen as { date?: unknown; sessions?: unknown } | undefined;
  if (!raw || typeof raw.date !== 'string' || !LOCAL_DATE_RE.test(raw.date)) return null;
  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  return { date: raw.date, sessions };
}

function readReminder(metadata: Record<string, unknown> | null): AudiobookReminderPref | null {
  const raw = metadata?.audiobook_reminder as { time?: unknown; tz?: unknown } | undefined;
  if (!raw || typeof raw.time !== 'string' || typeof raw.tz !== 'string') return null;
  return { time: raw.time, tz: raw.tz };
}

/** True for a time zone name the runtime (and Postgres) can resolve. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validate a reminder preference; null when it isn't one. */
export function parseReminderPref(input: unknown): AudiobookReminderPref | null {
  const o = input as { time?: unknown; tz?: unknown } | null;
  if (!o || typeof o.time !== 'string' || typeof o.tz !== 'string') return null;
  if (!REMINDER_TIME_RE.test(o.time) || !isValidTimeZone(o.tz)) return null;
  return { time: o.time, tz: o.tz };
}

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
    dailyListen: readDailyListen(row.metadata),
    audiobookReminder: readReminder(row.metadata),
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
  localDate?: string | null,
): Promise<JourneyState> {
  const row = await ensureState(client, userId);

  const safeSession = Number.isInteger(session) && session > 0 ? session : 1;
  // Listening to session N means the user is now on N+1. Never rewind.
  const nextCurrent = Math.max(row.current_session, safeSession + 1);

  const patch: Record<string, unknown> = { updated_at: now };
  if (nextCurrent !== row.current_session) patch.current_session = nextCurrent;
  // A not_started user who listens is now in progress.
  if (row.onboarding_status === 'not_started') patch.onboarding_status = 'in_progress';

  // VTID-04763: the "one episode a day" goal, kept per the member's own
  // calendar day so it reads the same on every device. A new day replaces
  // the record; the same day accumulates distinct episodes.
  if (localDate && LOCAL_DATE_RE.test(localDate)) {
    const today = readDailyListen(row.metadata);
    const sessions = today && today.date === localDate ? today.sessions : [];
    if (!sessions.includes(safeSession)) {
      patch.metadata = {
        ...(row.metadata ?? {}),
        daily_listen: { date: localDate, sessions: [...sessions, safeSession] },
      };
    }
  }

  // Nothing actually advanced (replay of an already-passed session, status
  // already moved, episode already counted today) — skip the write.
  const advances =
    'current_session' in patch || 'onboarding_status' in patch || 'metadata' in patch;
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

/**
 * VTID-04763 — set or clear the member's daily Audiobook reminder. Stored in
 * the state row's metadata; `last_sent_local_date` (written only by the
 * dispatcher's atomic claim) survives a time change so changing the time can
 * never send twice in one day.
 */
export async function setAudiobookReminder(
  client: SupabaseClient,
  userId: string,
  pref: AudiobookReminderPref | null,
  now: string = new Date().toISOString(),
): Promise<JourneyState> {
  const row = await ensureState(client, userId);
  const metadata: Record<string, unknown> = { ...(row.metadata ?? {}) };
  if (pref) {
    const prev = (metadata.audiobook_reminder ?? {}) as Record<string, unknown>;
    metadata.audiobook_reminder = {
      time: pref.time,
      tz: pref.tz,
      ...(typeof prev.last_sent_local_date === 'string'
        ? { last_sent_local_date: prev.last_sent_local_date }
        : {}),
    };
  } else {
    delete metadata.audiobook_reminder;
  }
  const updated = await client
    .from(TABLE)
    .update({ metadata, updated_at: now })
    .eq('user_id', userId)
    .select('*')
    .single();
  if (updated.error) throw updated.error;
  return toJourneyState(updated.data as GuidedJourneyStateRow);
}
