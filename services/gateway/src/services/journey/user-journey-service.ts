/**
 * VTID-03152 — Slice A: user_journey persistence layer.
 *
 * Source of truth for a user's journey state. Replaces the live-math
 * `buildJourney(daysSinceSignup)` path in awareness-context.ts as the
 * canonical reader; that math survives only as a fallback for users
 * whose row was missed by the backfill (transition window).
 *
 * Slice B (GET /api/v1/my-journey) and the forthcoming conversational
 * slices (D daily morning greeting, C one-time welcome, G milestones,
 * H gap recovery) all consume `getJourneyState()`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_WAVE_CONFIG, type WaveDefinition } from '../wave-defaults';

const JOURNEY_TOTAL_DAYS_DEFAULT = 90;
const GREETING_OPENINGS_MAX = 5;

export type JourneyPlanType = 'default' | 'personalized';
export type JourneyStatus = 'active' | 'paused' | 'complete' | 'restarted';

/** Persisted row (mirrors public.user_journey). */
export interface UserJourneyRow {
  user_id: string;
  tenant_id: string | null;
  started_at: string;
  total_days: number;
  plan_type: JourneyPlanType;
  plan_summary: string | null;
  current_wave_id: string | null;
  current_milestone_id: string | null;
  status: JourneyStatus;
  completed_milestone_ids: string[];
  is_first_session: boolean;
  last_session_date: string | null;
  last_acknowledged_day: number | null;
  recent_greeting_openings: string[];
  plan_negotiated_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Computed view returned to callers. Combines the row with derived day_in_journey, current_wave, days_left. */
export interface JourneyState {
  user_id: string;
  tenant_id: string | null;
  started_at: string;
  total_days: number;
  plan_type: JourneyPlanType;
  plan_summary: string | null;
  status: JourneyStatus;
  is_first_session: boolean;
  last_session_date: string | null;
  recent_greeting_openings: string[];
  completed_milestone_ids: string[];
  last_acknowledged_day: number | null;

  // Derived:
  day_in_journey: number;
  days_left: number;
  is_past_total_days: boolean;
  current_wave: { id: string; name: string; description: string; start_day: number; end_day: number } | null;
  /** When true the row was missing and the state was computed from the math fallback. */
  fallback_used: boolean;
}

/** Compute day_in_journey from started_at. Floor to whole days. */
export function computeDayInJourney(startedAt: string | Date, now: Date = new Date()): number {
  const start = typeof startedAt === 'string' ? new Date(startedAt) : startedAt;
  const ms = now.getTime() - start.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Resolve the wave the user is in for a given day. NULL when past the
 * configured waves.
 *
 * Picks the wave with the **earliest end_day** — i.e. "the phase the
 * user is about to graduate from". This matches the existing
 * `buildJourney` behavior in awareness-context.ts so both readers
 * agree on which wave is "current" for the same day.
 */
export function resolveCurrentWave(dayInJourney: number): WaveDefinition | null {
  const enabled = DEFAULT_WAVE_CONFIG.filter((w) => w.enabled);
  const matching = enabled.filter(
    (w) => dayInJourney >= w.timeline.start_day && dayInJourney <= w.timeline.end_day,
  );
  if (matching.length === 0) return null;
  const sorted = [...matching].sort((a, b) => a.timeline.end_day - b.timeline.end_day);
  return sorted[0];
}

function toState(row: UserJourneyRow, fallbackUsed = false): JourneyState {
  const day = computeDayInJourney(row.started_at);
  const wave = resolveCurrentWave(day);
  const daysLeft = Math.max(0, row.total_days - day);
  return {
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    started_at: row.started_at,
    total_days: row.total_days,
    plan_type: row.plan_type,
    plan_summary: row.plan_summary,
    status: row.status,
    is_first_session: row.is_first_session,
    last_session_date: row.last_session_date,
    recent_greeting_openings: row.recent_greeting_openings ?? [],
    completed_milestone_ids: row.completed_milestone_ids ?? [],
    last_acknowledged_day: row.last_acknowledged_day,
    day_in_journey: day,
    days_left: daysLeft,
    is_past_total_days: day >= row.total_days,
    current_wave: wave
      ? {
          id: wave.id,
          name: wave.name,
          description: wave.description,
          start_day: wave.timeline.start_day,
          end_day: wave.timeline.end_day,
        }
      : null,
    fallback_used: fallbackUsed,
  };
}

/**
 * Read the user_journey row, computing derived fields. When the row is
 * missing (user predates backfill or backfill was skipped), fall back
 * to math against app_users.created_at and return is_first_session=false.
 *
 * Never throws. On DB error returns null.
 */
export async function getJourneyState(
  client: SupabaseClient,
  userId: string,
): Promise<JourneyState | null> {
  try {
    const { data, error } = await client
      .from('user_journey')
      .select(
        'user_id, tenant_id, started_at, total_days, plan_type, plan_summary, current_wave_id, ' +
          'current_milestone_id, status, completed_milestone_ids, is_first_session, last_session_date, ' +
          'last_acknowledged_day, recent_greeting_openings, plan_negotiated_at, created_at, updated_at',
      )
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.warn(`[journey-service] getJourneyState DB error for ${userId.slice(0, 8)}:`, error.message);
      return null;
    }

    if (data) return toState(data as unknown as UserJourneyRow);

    // Fallback: synthesize from app_users.created_at.
    const { data: userRow, error: userErr } = await client
      .from('app_users')
      .select('user_id, created_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (userErr || !userRow) return null;
    const synth: UserJourneyRow = {
      user_id: userRow.user_id,
      tenant_id: null,
      started_at: userRow.created_at,
      total_days: JOURNEY_TOTAL_DAYS_DEFAULT,
      plan_type: 'default',
      plan_summary: null,
      current_wave_id: null,
      current_milestone_id: null,
      status: 'active',
      completed_milestone_ids: [],
      is_first_session: false,
      last_session_date: null,
      last_acknowledged_day: null,
      recent_greeting_openings: [],
      plan_negotiated_at: null,
      created_at: userRow.created_at,
      updated_at: userRow.created_at,
    };
    return toState(synth, true);
  } catch (err: any) {
    console.warn(`[journey-service] getJourneyState unexpected for ${userId.slice(0, 8)}:`, err.message);
    return null;
  }
}

/**
 * Idempotently create a user_journey row if one doesn't exist. Called on
 * /me to seed new users. Returns true when a row was created, false when
 * it already existed or creation was skipped.
 */
export async function ensureUserJourneyRow(
  client: SupabaseClient,
  userId: string,
  opts: { tenant_id?: string | null; started_at?: string | Date; is_first_session?: boolean } = {},
): Promise<boolean> {
  try {
    const startedAtIso =
      opts.started_at instanceof Date
        ? opts.started_at.toISOString()
        : opts.started_at ?? new Date().toISOString();
    const { data, error } = await client
      .from('user_journey')
      .insert({
        user_id: userId,
        tenant_id: opts.tenant_id ?? null,
        started_at: startedAtIso,
        // Defaults to true so the /me seeding path (brand-new users) is
        // unchanged. The session-start backfill passes false: a user reaching
        // a live session WITHOUT a row is an existing user the backfill missed,
        // not a first-ever signup — seeding them as first_session would (re)play
        // the one-time welcome on the legacy continuation path.
        is_first_session: opts.is_first_session ?? true,
      })
      .select('user_id')
      .maybeSingle();
    if (error) {
      // 23505 = unique_violation = row already exists. Idempotent path.
      if ((error as any).code === '23505') return false;
      console.warn(`[journey-service] ensureUserJourneyRow error for ${userId.slice(0, 8)}:`, error.message);
      return false;
    }
    return !!data;
  } catch (err: any) {
    console.warn(`[journey-service] ensureUserJourneyRow unexpected:`, err.message);
    return false;
  }
}

/**
 * Mark the session end and update the trigger fields the conversational
 * slices read on the next session:
 *   - last_session_date (advances when current login is a new calendar
 *     day in user TZ — caller passes the date string YYYY-MM-DD)
 *   - is_first_session → false after the first session ends
 *   - recent_greeting_openings push (capped at GREETING_OPENINGS_MAX)
 *   - last_acknowledged_day (when caller explicitly acknowledges a milestone)
 *
 * All fields are optional. Never throws.
 */
export async function updateSessionEndState(
  client: SupabaseClient,
  userId: string,
  patch: {
    last_session_date?: string;
    clear_first_session?: boolean;
    pushed_greeting_opening?: string;
    last_acknowledged_day?: number;
  },
): Promise<void> {
  try {
    const update: Record<string, unknown> = {};
    if (patch.last_session_date) update.last_session_date = patch.last_session_date;
    if (patch.clear_first_session) update.is_first_session = false;
    if (typeof patch.last_acknowledged_day === 'number')
      update.last_acknowledged_day = patch.last_acknowledged_day;

    if (patch.pushed_greeting_opening) {
      const { data: existing } = await client
        .from('user_journey')
        .select('recent_greeting_openings')
        .eq('user_id', userId)
        .maybeSingle();
      const current: string[] =
        (existing?.recent_greeting_openings as string[] | undefined) ?? [];
      const next = [patch.pushed_greeting_opening, ...current].slice(0, GREETING_OPENINGS_MAX);
      update.recent_greeting_openings = next;
    }

    if (Object.keys(update).length === 0) return;

    const { error } = await client.from('user_journey').update(update).eq('user_id', userId);
    if (error) {
      console.warn(`[journey-service] updateSessionEndState error for ${userId.slice(0, 8)}:`, error.message);
    }
  } catch (err: any) {
    console.warn(`[journey-service] updateSessionEndState unexpected:`, err.message);
  }
}
