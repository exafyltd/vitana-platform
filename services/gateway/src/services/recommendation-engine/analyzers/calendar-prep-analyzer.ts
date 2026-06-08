/**
 * BOOTSTRAP-AUTOPILOT-EXPANSION: Calendar Prep Analyzer — flag-gated, OFF by default.
 *
 * A new, additive signal source for the Autopilot recommendation engine. It
 * broadens coverage to the calendar surface: when a user has an upcoming
 * wellness-pillar `calendar_events` row happening soon (e.g. a workout or sleep
 * block) but has NOT scheduled a short supporting "prep" block before it, the
 * analyzer surfaces a low-risk nudge to add one. This lets Autopilot help users
 * follow through on plans they already made, instead of only reacting to past
 * signals (codebase/oasis/health) or biometrics (wearable).
 *
 * Gated behind FEATURE_AUTOPILOT_CALENDAR_PREP_ENV (see services/feature-flags.ts).
 * When OFF (default), the generator never imports/runs this analyzer, so there
 * is zero behavior change. The classification logic is pure (no DB, no I/O) and
 * fully unit-tested; the DB fetch is a thin wrapper around it.
 *
 * Contract parity with wearable-analyzer.ts:
 *   - exports an `analyze...` async fn returning { ok, signals, summary, error? }
 *   - exports a `generate...Fingerprint` fn for daily-bucketed dedup
 *   - signals are per-user, downstream converted into a GeneratedRecommendation
 */

import { createHash } from 'crypto';
import { getSupabase } from '../../../lib/supabase';

const LOG_PREFIX = '[BOOTSTRAP-AUTOPILOT-EXPANSION:CalendarPrep]';

/** Canonical wellness pillars (mirrors calendar_events.pillar CHECK constraint). */
export type WellnessPillar = 'nutrition' | 'hydration' | 'exercise' | 'sleep' | 'mental';

/** Minimal projection of a calendar_events row this analyzer reasons over. */
export interface CalendarEventRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  /** ISO timestamp. */
  start_time: string;
  /** Typed pillar column (nullable — legacy rows have no pillar). */
  pillar: WellnessPillar | null;
  event_type: string | null;
  status: string | null;
  /** 'autopilot' for events Autopilot itself created; used to detect existing prep. */
  source_type: string | null;
}

export interface CalendarPrepSignal {
  user_id: string;
  tenant_id: string | null;
  pillar: WellnessPillar;
  /** id of the upcoming event that triggered this prep nudge. */
  target_event_id: string;
  severity: 'low' | 'medium' | 'high';
  confidence: number; // 0..1
  /** Hours until the target event starts (rounded, for transparency). */
  hours_until: number;
  summary: string; // human-readable for the autopilot card / voice
}

export interface CalendarPrepAnalysisResult {
  ok: boolean;
  signals: CalendarPrepSignal[];
  summary: {
    events_analyzed: number;
    users_with_signals: number;
    signals_generated: number;
    duration_ms: number;
  };
  error?: string;
}

export interface CalendarPrepConfig {
  /** Only consider events starting within this many hours from `now`. */
  lookahead_hours: number;
  /** A prep block this many minutes before counts as "already prepared". */
  prep_window_minutes: number;
  /** Events sooner than this are "imminent" → higher severity. */
  imminent_hours: number;
}

export const DEFAULT_CALENDAR_PREP_CONFIG: CalendarPrepConfig = {
  lookahead_hours: 48,
  prep_window_minutes: 120,
  imminent_hours: 6,
};

/**
 * Per-pillar copy for the nudge. Kept here (pure data) so tests can assert the
 * mapping without spinning up the LLM or DB. source_ref downstream is keyed by
 * pillar so the existing COMMUNITY_ACTIONS `pillar_template_*` entries can map
 * the activation to a schedulable wellness block.
 */
const PILLAR_PREP_COPY: Record<WellnessPillar, string> = {
  nutrition: 'plan a quick balanced meal so you are fuelled going in',
  hydration: 'set a hydration reminder beforehand',
  exercise: 'block 10 minutes to warm up and get your gear ready',
  sleep: 'add a wind-down block so the sleep window actually sticks',
  mental: 'add a short breathing or grounding moment to arrive centred',
};

/**
 * PURE: decide whether a single upcoming event needs a prep nudge.
 *
 * Rules (all pure, deterministic — no clock reads beyond the injected `now`):
 *   1. Event must have a recognised wellness `pillar` and not be cancelled.
 *   2. Event must start in the future, within `lookahead_hours`.
 *   3. There must be NO existing event for the same user/pillar starting in the
 *      `prep_window_minutes` before it (that would already be the prep block).
 *   4. Severity: high if imminent (< imminent_hours) AND today; medium if
 *      imminent; otherwise low. Confidence scales inversely with lead time.
 *
 * Returns null when no nudge is warranted.
 */
export function classifyCalendarPrep(
  target: CalendarEventRow,
  sameUserPillarEvents: CalendarEventRow[],
  now: Date,
  config: CalendarPrepConfig = DEFAULT_CALENDAR_PREP_CONFIG,
): CalendarPrepSignal | null {
  if (!target.pillar) return null;
  if (target.status === 'cancelled') return null;

  const startMs = Date.parse(target.start_time);
  if (Number.isNaN(startMs)) return null;

  const nowMs = now.getTime();
  const deltaMs = startMs - nowMs;
  if (deltaMs <= 0) return null; // already started / past

  const hoursUntil = deltaMs / (1000 * 60 * 60);
  if (hoursUntil > config.lookahead_hours) return null;

  // Already prepared? Any other (non-cancelled) event for the same pillar that
  // starts within the prep window before the target counts as a prep block.
  const prepWindowMs = config.prep_window_minutes * 60 * 1000;
  const alreadyPrepared = sameUserPillarEvents.some((e) => {
    if (e.id === target.id) return false;
    if (e.status === 'cancelled') return false;
    if (e.pillar !== target.pillar) return false;
    const eStart = Date.parse(e.start_time);
    if (Number.isNaN(eStart)) return false;
    // Prep block must start strictly before the target, no earlier than the window.
    return eStart < startMs && startMs - eStart <= prepWindowMs;
  });
  if (alreadyPrepared) return null;

  const imminent = hoursUntil <= config.imminent_hours;
  const sameDay = new Date(startMs).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  const severity: CalendarPrepSignal['severity'] = imminent && sameDay ? 'high' : imminent ? 'medium' : 'low';

  // Confidence: more lead time = lower confidence the nudge is timely.
  // Clamped to [0.4, 0.9]. Imminent same-day events are most actionable.
  const leadFactor = 1 - Math.min(hoursUntil / config.lookahead_hours, 1);
  const confidence = Math.round((0.4 + leadFactor * 0.5) * 100) / 100;

  const roundedHours = Math.max(1, Math.round(hoursUntil));
  const when = roundedHours <= 1 ? 'within the hour' : `in about ${roundedHours}h`;
  const prepCopy = PILLAR_PREP_COPY[target.pillar];

  return {
    user_id: target.user_id,
    tenant_id: target.tenant_id,
    pillar: target.pillar,
    target_event_id: target.id,
    severity,
    confidence,
    hours_until: roundedHours,
    summary: `You have a ${target.pillar} block ${when} with nothing lined up before it — ${prepCopy}.`,
  };
}

/**
 * PURE: classify a whole batch of events for many users. Groups by user+pillar
 * internally so the "already prepared" check only ever sees that user's events.
 * Emits at most one signal per (user, pillar) — the soonest qualifying event —
 * to avoid flooding the queue.
 */
export function classifyCalendarPrepBatch(
  events: CalendarEventRow[],
  now: Date,
  config: CalendarPrepConfig = DEFAULT_CALENDAR_PREP_CONFIG,
): CalendarPrepSignal[] {
  // Index events by user for the prep-window lookup.
  const byUser = new Map<string, CalendarEventRow[]>();
  for (const e of events) {
    const list = byUser.get(e.user_id) ?? [];
    list.push(e);
    byUser.set(e.user_id, list);
  }

  const out: CalendarPrepSignal[] = [];
  for (const [, userEvents] of byUser) {
    // Soonest-first so the per-(user,pillar) dedup keeps the most urgent.
    const sorted = [...userEvents].sort(
      (a, b) => Date.parse(a.start_time) - Date.parse(b.start_time),
    );
    const seenPillars = new Set<WellnessPillar>();
    for (const ev of sorted) {
      if (ev.pillar && seenPillars.has(ev.pillar)) continue;
      const sig = classifyCalendarPrep(ev, userEvents, now, config);
      if (sig) {
        out.push(sig);
        seenPillars.add(sig.pillar);
      }
    }
  }
  return out;
}

/**
 * DB wrapper. Fetches upcoming wellness-pillar events and delegates to the pure
 * batch classifier. Never throws — returns { ok:false } on infra failure so the
 * generator's per-source try/catch records an error without aborting siblings.
 */
export async function analyzeCalendarPrep(
  opts: { user_ids?: string[]; limit?: number; now?: Date; config?: Partial<CalendarPrepConfig> } = {},
): Promise<CalendarPrepAnalysisResult> {
  const startTime = Date.now();
  const now = opts.now ?? new Date();
  const config: CalendarPrepConfig = { ...DEFAULT_CALENDAR_PREP_CONFIG, ...opts.config };

  const supabase = getSupabase();
  if (!supabase) {
    return {
      ok: false,
      signals: [],
      summary: { events_analyzed: 0, users_with_signals: 0, signals_generated: 0, duration_ms: 0 },
      error: 'Supabase unavailable',
    };
  }

  const horizon = new Date(now.getTime() + config.lookahead_hours * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from('calendar_events')
    .select('id,user_id,tenant_id,start_time,pillar,event_type,status,source_type')
    .not('pillar', 'is', null)
    .neq('status', 'cancelled')
    .gte('start_time', now.toISOString())
    .lte('start_time', horizon)
    .order('start_time', { ascending: true })
    .limit(opts.limit ?? 1000);
  if (opts.user_ids?.length) {
    query = query.in('user_id', opts.user_ids);
  }

  const { data, error } = await query;
  if (error) {
    return {
      ok: false,
      signals: [],
      summary: {
        events_analyzed: 0,
        users_with_signals: 0,
        signals_generated: 0,
        duration_ms: Date.now() - startTime,
      },
      error: error.message,
    };
  }

  const rows = (data ?? []) as CalendarEventRow[];
  const signals = classifyCalendarPrepBatch(rows, now, config);
  const usersWithSignals = new Set(signals.map((s) => s.user_id)).size;

  const duration = Date.now() - startTime;
  console.log(
    `${LOG_PREFIX} analyzed ${rows.length} upcoming events, generated ${signals.length} signals in ${duration}ms`,
  );

  return {
    ok: true,
    signals,
    summary: {
      events_analyzed: rows.length,
      users_with_signals: usersWithSignals,
      signals_generated: signals.length,
      duration_ms: duration,
    },
  };
}

/**
 * Daily-bucketed fingerprint so a user gets at most one prep nudge per pillar
 * per day, mirroring the wearable analyzer's dedup strategy.
 */
export function generateCalendarPrepFingerprint(signal: CalendarPrepSignal): string {
  const day = new Date().toISOString().slice(0, 10);
  const data = `calendar_prep:${signal.user_id}:${signal.pillar}:${day}`;
  return createHash('sha256').update(data).digest('hex').substring(0, 16);
}
