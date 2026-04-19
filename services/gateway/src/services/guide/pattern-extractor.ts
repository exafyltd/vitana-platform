/**
 * Companion Phase C — Pattern Extractor (VTID-01936)
 *
 * Reads the last 30 days of completed calendar_events per user, extracts
 * routine/rhythm signals, and writes user_routines rows. Brain reads these
 * to weave naturally ("I noticed you usually do diary on Sundays — want
 * to keep that rhythm?").
 *
 * Designed to be triggered:
 *   - Manually (POST /api/v1/guide/pattern-extract — separate route, future)
 *   - Nightly (via existing scheduler.ts pattern — separate VTID to wire cron)
 *   - On-demand (e.g., after a major calendar update)
 *
 * STATUS: function is fully implemented + idempotent. Cron wiring is
 * deferred — for now the function is exposed and can be invoked manually
 * or by a future scheduled job.
 */

import { getSupabase } from '../../lib/supabase';
import { emitGuideTelemetry } from './guide-telemetry';

const LOG_PREFIX = '[Guide:pattern-extractor]';
const MIN_EVIDENCE = 3; // need at least 3 occurrences before claiming a pattern
const LOOKBACK_DAYS = 30;
const MIN_CONFIDENCE = 0.4;

export type RoutineKind =
  | 'time_of_day_preference'
  | 'day_of_week_rhythm'
  | 'category_affinity'
  | 'wave_velocity'
  | 'completion_streak';

export interface RoutineRow {
  routine_kind: RoutineKind;
  routine_key: string;
  title: string;
  summary: string;
  evidence_count: number;
  confidence: number;
  metadata: Record<string, unknown>;
  first_observed: string;
  last_observed: string;
}

export interface ExtractResult {
  user_id: string;
  routines_written: number;
  routines: RoutineRow[];
  events_examined: number;
}

/**
 * Read the user's recent routine patterns. Read-only; for awareness consumption.
 */
export async function getUserRoutines(userId: string, limit: number = 8): Promise<RoutineRow[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('user_routines')
    .select('routine_kind, routine_key, title, summary, evidence_count, confidence, metadata, first_observed, last_observed')
    .eq('user_id', userId)
    .gte('confidence', MIN_CONFIDENCE)
    .order('confidence', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn(`${LOG_PREFIX} read failed:`, error.message);
    return [];
  }
  return (data || []) as RoutineRow[];
}

/**
 * Extract patterns from the last 30 days of calendar_events for a user
 * and upsert them into user_routines. Idempotent — re-running on the same
 * data updates the same rows (UNIQUE on user_id + routine_kind + routine_key).
 *
 * Pattern types (MVP):
 *   - time_of_day_preference: % of completed events in morning/afternoon/evening
 *   - day_of_week_rhythm:    days where >40% of events happen
 *   - category_affinity:    wellness_tags appearing on >25% of completed events
 *
 * Returns the routines that were derived. Returns empty if insufficient data
 * (we never write low-confidence noise).
 */
export async function extractPatternsForUser(userId: string): Promise<ExtractResult> {
  const supabase = getSupabase();
  if (!supabase) {
    return { user_id: userId, routines_written: 0, routines: [], events_examined: 0 };
  }

  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  const { data: events, error } = await supabase
    .from('calendar_events')
    .select('id, start_time, completion_status, status, event_type, wellness_tags, time_slot')
    .eq('user_id', userId)
    .gte('start_time', sinceIso);

  if (error || !events) {
    console.warn(`${LOG_PREFIX} fetch events failed for ${userId.substring(0, 8)}:`, error?.message);
    return { user_id: userId, routines_written: 0, routines: [], events_examined: 0 };
  }

  type EvShape = {
    id: string;
    start_time: string;
    completion_status: string | null;
    status: string;
    event_type: string;
    wellness_tags: string[] | null;
    time_slot: string | null;
  };

  const evList = (events as EvShape[]).filter((e) => e.start_time);
  const completed = evList.filter(
    (e) => e.completion_status === 'completed' || e.status === 'completed',
  );

  const eventsExamined = evList.length;

  // Insufficient data → don't write noise
  if (completed.length < MIN_EVIDENCE) {
    console.log(
      `${LOG_PREFIX} insufficient completed events for ${userId.substring(0, 8)} (${completed.length} < ${MIN_EVIDENCE}) — skipping`,
    );
    return { user_id: userId, routines_written: 0, routines: [], events_examined: eventsExamined };
  }

  const routines: RoutineRow[] = [];
  const now = new Date().toISOString();

  // Time-of-day preference (morning <12, afternoon 12-18, evening >=18, by start_time hour UTC)
  const todBuckets = { morning: 0, afternoon: 0, evening: 0 };
  for (const ev of completed) {
    const h = new Date(ev.start_time).getUTCHours();
    if (h < 12) todBuckets.morning += 1;
    else if (h < 18) todBuckets.afternoon += 1;
    else todBuckets.evening += 1;
  }
  const todTotal = completed.length;
  for (const [tod, count] of Object.entries(todBuckets) as Array<['morning' | 'afternoon' | 'evening', number]>) {
    const pct = count / todTotal;
    if (pct >= 0.5 && count >= MIN_EVIDENCE) {
      routines.push({
        routine_kind: 'time_of_day_preference',
        routine_key: `tod:${tod}`,
        title: `${tod} preference`,
        summary: `${Math.round(pct * 100)}% of completed activities happen in the ${tod}`,
        evidence_count: count,
        confidence: Math.min(0.95, 0.4 + pct / 2),
        metadata: { time_of_day: tod, total_evidence: todTotal },
        first_observed: now,
        last_observed: now,
      });
    }
  }

  // Day-of-week rhythm
  const dowCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const ev of completed) {
    const d = new Date(ev.start_time).getUTCDay();
    dowCounts[d] += 1;
  }
  const dowTotal = completed.length;
  const dowNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (const [d, count] of Object.entries(dowCounts)) {
    const pct = count / dowTotal;
    if (pct >= 0.25 && count >= MIN_EVIDENCE) {
      const name = dowNames[Number(d)];
      routines.push({
        routine_kind: 'day_of_week_rhythm',
        routine_key: `dow:${d}`,
        title: `${name} rhythm`,
        summary: `~${Math.round(pct * 100)}% of activity happens on ${name}`,
        evidence_count: count,
        confidence: Math.min(0.95, 0.35 + pct),
        metadata: { day_of_week: name, dow_index: Number(d) },
        first_observed: now,
        last_observed: now,
      });
    }
  }

  // Category affinity (wellness_tags)
  const tagCounts: Record<string, number> = {};
  for (const ev of completed) {
    if (Array.isArray(ev.wellness_tags)) {
      for (const tag of ev.wellness_tags) {
        if (typeof tag === 'string' && tag.trim()) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
      }
    }
  }
  for (const [tag, count] of Object.entries(tagCounts)) {
    const pct = count / completed.length;
    if (pct >= 0.25 && count >= MIN_EVIDENCE) {
      routines.push({
        routine_kind: 'category_affinity',
        routine_key: `tag:${tag}`,
        title: `${tag} affinity`,
        summary: `engages with "${tag}" activities ${Math.round(pct * 100)}% of the time`,
        evidence_count: count,
        confidence: Math.min(0.95, 0.4 + pct),
        metadata: { tag },
        first_observed: now,
        last_observed: now,
      });
    }
  }

  // Persist (upsert) — idempotent on (user_id, routine_kind, routine_key)
  let written = 0;
  for (const r of routines) {
    const { error: upsertErr } = await supabase.from('user_routines').upsert(
      {
        user_id: userId,
        routine_kind: r.routine_kind,
        routine_key: r.routine_key,
        title: r.title,
        summary: r.summary,
        evidence_count: r.evidence_count,
        confidence: r.confidence,
        metadata: r.metadata,
        last_observed: r.last_observed,
        updated_at: r.last_observed,
      },
      { onConflict: 'user_id,routine_kind,routine_key' },
    );
    if (upsertErr) {
      console.warn(`${LOG_PREFIX} upsert ${r.routine_kind}:${r.routine_key} failed:`, upsertErr.message);
      continue;
    }
    written += 1;
  }

  if (written > 0) {
    emitGuideTelemetry('guide.patterns.extracted', {
      user_id: userId,
      routines_written: written,
      events_examined: eventsExamined,
      kinds: Array.from(new Set(routines.map((r) => r.routine_kind))),
    }).catch(() => {});
    console.log(
      `${LOG_PREFIX} extracted ${written} routines for user ${userId.substring(0, 8)} from ${eventsExamined} events`,
    );
  }

  return { user_id: userId, routines_written: written, routines, events_examined: eventsExamined };
}
