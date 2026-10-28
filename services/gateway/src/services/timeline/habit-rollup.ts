/**
 * VTID-05171 — Life Timeline P5: habit rollups + "Vitana noticed".
 *
 * Every screen visit is stored (silent tier) but never shown. This rollup is
 * where those rows become useful: once a day it turns the last 28 days of a
 * member's activity into a handful of user_routines rows the companion reads
 * ([ROUTINES] block in the profiler, the Memory overview in the app):
 *
 *   screen_habit      screens the member returns to on many different days
 *   active_hours      the part of the day the member is usually active in
 *   feature_affinity  the life areas (catalog categories) used most
 *   pillar_rhythm     when each health pillar is usually logged or synced
 *
 * It also writes at most one "Vitana noticed" spotlight per member per day
 * (`index.insight.noticed`, params insight_kind + pillar only — the app
 * renders the sentence) from the Index history: a pillar that has been the
 * weakest for 5+ days while it costs balance, or a pillar moving ±10 in a
 * week. The same insight is not repeated within 7 days; the member can
 * delete it on the timeline like any other entry.
 *
 * Learning switches (timeline_learning_prefs): `app_usage` off → no
 * screen_habit / active_hours / feature_affinity for that member and the
 * existing ones are deleted (owner default D2); a category off → its rows are
 * left out and its routines deleted; a pillar off → no rhythm or insight for
 * it. Rows the member hid from Vitana (hidden_from_ai) never count.
 *
 * Own automation (AP-0916); AP-0906's calendar pattern extractor is unchanged.
 * Titles/summaries are English on purpose: they are read by the LLM (§13b,
 * "system instructions do not need translation"); the app renders routines
 * from routine_kind + metadata, never from these strings.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { PILLAR_KEYS, type PillarKey } from '../../lib/vitana-pillars';
import { userLocalHour, getUserTimezone } from '../daily-pace-service';
import { writeTimelineRow } from '../timeline-projector';
import { classifyActivityType } from './catalog';
import { isMissingSchema, type ScoreRow } from './timeline-repository';
import {
  APP_USAGE_ROUTINE_KINDS,
  PILLAR_RHYTHM_KIND,
  fetchLearningPrefsFor,
  type LearningPrefs,
  ALL_ON,
} from './learning-prefs';

export const ROLLUP_WINDOW_DAYS = 28;
export const ROLLUP_ROUTINE_KINDS = [...APP_USAGE_ROUTINE_KINDS, PILLAR_RHYTHM_KIND] as const;
const ROWS_PER_USER = 3000;
const ACTIVE_USER_SCAN = 5000;
const DEFAULT_MAX_USERS = 400;

export type HourBucket = 'morning' | 'midday' | 'afternoon' | 'evening' | 'night';

export function bucketOfHour(h: number): HourBucket {
  if (h >= 5 && h < 10) return 'morning';
  if (h >= 10 && h < 13) return 'midday';
  if (h >= 13 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

export interface RollupRow {
  activity_type: string;
  activity_data: Record<string, unknown> | null;
  created_at: string;
  tier: string | null;
  category: string | null;
  pillar: string | null;
  hidden_from_ai?: boolean | null;
}

export interface RoutineOut {
  routine_kind: (typeof ROLLUP_ROUTINE_KINDS)[number];
  routine_key: string;
  title: string;
  summary: string;
  evidence_count: number;
  confidence: number;
  metadata: Record<string, unknown>;
}

const NOT_AFFINITY = new Set(['system', 'app_usage', 'index', 'account']);

function localDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function topBucket(hours: number[]): { bucket: HourBucket; share: number; peak_hour: number } | null {
  if (hours.length === 0) return null;
  const buckets = new Map<HourBucket, number>();
  const perHour = new Array(24).fill(0);
  for (const h of hours) {
    buckets.set(bucketOfHour(h), (buckets.get(bucketOfHour(h)) ?? 0) + 1);
    perHour[h] += 1;
  }
  const [bucket, n] = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0];
  const peak_hour = perHour.indexOf(Math.max(...perHour));
  return { bucket, share: n / hours.length, peak_hour };
}

/** Normalise a classified row: hidden rows and rows of switched-off categories never count. */
function usable(rows: RollupRow[], prefs: LearningPrefs): RollupRow[] {
  return rows.filter((r) => !r.hidden_from_ai && !(r.category && prefs.off.has(r.category)));
}

/**
 * Pure: the routines one member's last 28 days support. Thresholds are
 * deliberately conservative — a routine claims a habit only when it held on
 * several different days.
 */
export function computeHabitRoutines(rawRows: RollupRow[], prefs: LearningPrefs, tz: string): RoutineOut[] {
  const rows = usable(rawRows, prefs);
  const out: RoutineOut[] = [];

  if (prefs.appUsage) {
    // screen_habit — page.view paths visited on ≥3 different days, ≥5 visits.
    const byPath = new Map<string, { visits: number; days: Set<string>; hours: number[] }>();
    for (const r of rows) {
      if (r.activity_type !== 'page.view') continue;
      const path = typeof r.activity_data?.path === 'string' ? (r.activity_data.path as string).split(/[?#]/)[0] : '';
      if (!path || path.length > 120) continue;
      const e = byPath.get(path) ?? { visits: 0, days: new Set<string>(), hours: [] };
      e.visits += 1;
      e.days.add(localDay(r.created_at, tz));
      e.hours.push(userLocalHour(new Date(r.created_at), tz));
      byPath.set(path, e);
    }
    const habits = [...byPath.entries()]
      .filter(([, e]) => e.visits >= 5 && e.days.size >= 3)
      .sort((a, b) => b[1].days.size - a[1].days.size || b[1].visits - a[1].visits)
      .slice(0, 3);
    for (const [path, e] of habits) {
      const tb = topBucket(e.hours)!;
      out.push({
        routine_kind: 'screen_habit',
        routine_key: path,
        title: `returns to ${path}`,
        summary: `opened ${path} on ${e.days.size} of the last ${ROLLUP_WINDOW_DAYS} days (${e.visits} visits), mostly in the ${tb.bucket}`,
        evidence_count: e.visits,
        confidence: round2(Math.min(0.95, 0.4 + e.days.size / ROLLUP_WINDOW_DAYS)),
        metadata: { path, days: e.days.size, visits: e.visits, bucket: tb.bucket },
      });
    }

    // active_hours — one part of the day holds ≥40% of ≥20 rows.
    const hours = rows.map((r) => userLocalHour(new Date(r.created_at), tz));
    const tb = rows.length >= 20 ? topBucket(hours) : null;
    if (tb && tb.share >= 0.4) {
      out.push({
        routine_kind: 'active_hours',
        routine_key: 'overall',
        title: `most active in the ${tb.bucket}`,
        summary: `${Math.round(tb.share * 100)}% of app activity in the last ${ROLLUP_WINDOW_DAYS} days happened in the ${tb.bucket}, peaking around ${tb.peak_hour}:00`,
        evidence_count: rows.length,
        confidence: round2(Math.min(0.95, tb.share)),
        metadata: { bucket: tb.bucket, share: round2(tb.share), peak_hour: tb.peak_hour },
      });
    }

    // feature_affinity — life areas with ≥15% of the meaningful rows (≥5 each), top 3.
    const counts = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      if (!r.category || NOT_AFFINITY.has(r.category)) continue;
      counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
      total += 1;
    }
    if (total >= 10) {
      const top = [...counts.entries()]
        .filter(([, n]) => n >= 5 && n / total >= 0.15)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      for (const [category, n] of top) {
        out.push({
          routine_kind: 'feature_affinity',
          routine_key: category,
          title: `engages most with ${category.replace(/_/g, ' ')}`,
          summary: `${Math.round((n / total) * 100)}% of meaningful activity in the last ${ROLLUP_WINDOW_DAYS} days was ${category.replace(/_/g, ' ')}`,
          evidence_count: n,
          confidence: round2(Math.min(0.95, 0.3 + n / total)),
          metadata: { category, share: round2(n / total), count: n },
        });
      }
    }
  }

  // pillar_rhythm — ≥4 pillar moments on ≥3 days; usual part of the day + days/week.
  for (const pillar of PILLAR_KEYS) {
    if (prefs.off.has(pillar)) continue;
    const mine = rows.filter((r) => r.pillar === pillar && (r.tier === 'moment' || r.tier === 'spotlight') && r.activity_type.startsWith('health.'));
    const days = new Set(mine.map((r) => localDay(r.created_at, tz)));
    if (mine.length < 4 || days.size < 3) continue;
    const tb = topBucket(mine.map((r) => userLocalHour(new Date(r.created_at), tz)))!;
    const perWeek = round2((days.size / ROLLUP_WINDOW_DAYS) * 7);
    out.push({
      routine_kind: 'pillar_rhythm',
      routine_key: pillar,
      title: `${pillar} usually logged in the ${tb.bucket}`,
      summary: `${pillar} was logged or synced on ${days.size} of the last ${ROLLUP_WINDOW_DAYS} days (~${perWeek} days a week), usually in the ${tb.bucket}`,
      evidence_count: mine.length,
      confidence: round2(Math.min(0.95, 0.4 + days.size / ROLLUP_WINDOW_DAYS)),
      metadata: { pillar, bucket: tb.bucket, typical_hour: tb.peak_hour, days: days.size, days_per_week: perWeek },
    });
  }
  return out;
}

export type InsightKind = 'weakest_pillar_streak' | 'pillar_slipping' | 'pillar_rising';
export interface Insight {
  insight_kind: InsightKind;
  pillar: PillarKey;
}

function pillarScore(r: ScoreRow, p: PillarKey): number {
  return Number((r as unknown as Record<string, unknown>)[`score_${p}`]) || 0;
}

/**
 * Pure: at most one insight from the last 7 daily Index rows (oldest first).
 * Order: the weakest pillar held for ≥5 days while balance costs points,
 * then a pillar down ≥10 in the window, then a pillar up ≥10.
 */
export function computeNoticedInsight(scores: ScoreRow[], prefs: LearningPrefs = ALL_ON): Insight | null {
  if (scores.length < 3) return null;
  const allowed = PILLAR_KEYS.filter((p) => !prefs.off.has(p));
  if (allowed.length === 0) return null;
  const weakestOf = (r: ScoreRow) => [...PILLAR_KEYS].sort((a, b) => pillarScore(r, a) - pillarScore(r, b))[0];

  const latest = scores[scores.length - 1];
  const bf = Number(latest.feature_inputs?.balance_factor ?? 1);
  const w = weakestOf(latest);
  let streak = 0;
  for (let i = scores.length - 1; i >= 0 && weakestOf(scores[i]) === w; i--) streak += 1;
  if (streak >= 5 && bf < 1 && allowed.includes(w)) return { insight_kind: 'weakest_pillar_streak', pillar: w };

  const first = scores[0];
  const deltas = allowed.map((p) => ({ p, d: pillarScore(latest, p) - pillarScore(first, p) }));
  const down = deltas.filter((x) => x.d <= -10).sort((a, b) => a.d - b.d)[0];
  if (down) return { insight_kind: 'pillar_slipping', pillar: down.p };
  const up = deltas.filter((x) => x.d >= 10).sort((a, b) => b.d - a.d)[0];
  if (up) return { insight_kind: 'pillar_rising', pillar: up.p };
  return null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const CLASSIFIED = 'activity_type, activity_data, created_at, tier, category, pillar, hidden_from_ai';
const LEGACY = 'activity_type, activity_data, created_at';

async function fetchUserRows(sb: SupabaseClient, userId: string, sinceIso: string): Promise<RollupRow[]> {
  const q = (cols: string) =>
    sb.from('user_activity_log').select(cols).eq('user_id', userId).gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(ROWS_PER_USER);
  const r = await q(CLASSIFIED);
  if (!r.error) {
    return ((r.data ?? []) as unknown as RollupRow[]).map((row) => {
      if (row.tier) return row;
      const c = classifyActivityType(row.activity_type); // not yet back-filled
      return { ...row, tier: c.tier, category: c.category, pillar: c.pillar };
    });
  }
  if (!isMissingSchema(r.error)) throw new Error(r.error.message);
  const legacy = await q(LEGACY);
  if (legacy.error) throw new Error(legacy.error.message);
  return ((legacy.data ?? []) as unknown as RollupRow[]).map((row) => {
    const c = classifyActivityType(row.activity_type);
    return { ...row, tier: c.tier, category: c.category, pillar: c.pillar, hidden_from_ai: false };
  });
}

async function persistRoutines(sb: SupabaseClient, userId: string, routines: RoutineOut[]): Promise<{ written: number; deleted: number }> {
  const now = new Date().toISOString();
  let written = 0;
  if (routines.length) {
    const { error } = await sb.from('user_routines').upsert(
      routines.map((r) => ({ user_id: userId, ...r, last_observed: now, updated_at: now })),
      { onConflict: 'user_id,routine_kind,routine_key' },
    );
    if (error) throw new Error(`user_routines upsert: ${error.message}`);
    written = routines.length;
  }
  // Stale rows of the rollup's own kinds: whatever this run no longer supports
  // (or the member switched off) goes. Other kinds are never touched.
  const keep = new Set(routines.map((r) => `${r.routine_kind}:${r.routine_key}`));
  const { data: existing, error: exErr } = await sb
    .from('user_routines')
    .select('id, routine_kind, routine_key')
    .eq('user_id', userId)
    .in('routine_kind', [...ROLLUP_ROUTINE_KINDS]);
  if (exErr) return { written, deleted: 0 };
  const stale = ((existing ?? []) as Array<{ id: string; routine_kind: string; routine_key: string }>)
    .filter((r) => !keep.has(`${r.routine_kind}:${r.routine_key}`))
    .map((r) => r.id);
  if (stale.length === 0) return { written, deleted: 0 };
  const del = await sb.from('user_routines').delete().eq('user_id', userId).in('id', stale);
  return { written, deleted: del.error ? 0 : stale.length };
}

async function maybeWriteInsight(sb: SupabaseClient, userId: string, prefs: LearningPrefs, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const { data: scores, error } = await sb
    .from('vitana_index_scores')
    .select('date, score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental, feature_inputs')
    .eq('user_id', userId)
    .gte('date', since)
    .order('date', { ascending: true });
  if (error || !scores?.length) return false;
  const insight = computeNoticedInsight(scores as ScoreRow[], prefs);
  if (!insight) return false;

  // Not the same insight twice in a week.
  const { data: recent } = await sb
    .from('user_activity_log')
    .select('activity_data')
    .eq('user_id', userId)
    .eq('activity_type', 'index.insight.noticed')
    .gte('created_at', new Date(now.getTime() - 7 * 86_400_000).toISOString())
    .limit(20);
  const seen = ((recent ?? []) as Array<{ activity_data: Record<string, unknown> | null }>).some(
    (r) => r.activity_data?.insight_kind === insight.insight_kind && r.activity_data?.pillar === insight.pillar,
  );
  if (seen) return false;

  await writeTimelineRow({
    user_id: userId,
    activity_type: 'index.insight.noticed',
    activity_data: { insight_kind: insight.insight_kind, pillar: insight.pillar },
    dedupe_key: `vitana-noticed:${userId}:${now.toISOString().slice(0, 10)}`, // ≤ 1 per member per day
    source: 'projector:timeline_habit_rollup',
  });
  return true;
}

export interface RollupResult {
  users_scanned: number;
  routines_written: number;
  routines_deleted: number;
  insights_written: number;
  errors: number;
}

export async function runTimelineHabitRollup(
  sb: SupabaseClient,
  opts: { maxUsers?: number; now?: Date; log?: (m: string) => void } = {},
): Promise<RollupResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => undefined);
  const result: RollupResult = { users_scanned: 0, routines_written: 0, routines_deleted: 0, insights_written: 0, errors: 0 };

  // Members active in the last day.
  const { data: active, error } = await sb
    .from('user_activity_log')
    .select('user_id')
    .gte('created_at', new Date(now.getTime() - 86_400_000).toISOString())
    .order('created_at', { ascending: false })
    .limit(ACTIVE_USER_SCAN);
  if (error) {
    log(`active-user scan failed: ${error.message}`);
    return result;
  }
  const userIds = [...new Set(((active ?? []) as Array<{ user_id: string }>).map((r) => r.user_id).filter(Boolean))].slice(0, opts.maxUsers ?? DEFAULT_MAX_USERS);
  const prefsByUser = await fetchLearningPrefsFor(sb, userIds);
  const sinceIso = new Date(now.getTime() - ROLLUP_WINDOW_DAYS * 86_400_000).toISOString();

  for (const userId of userIds) {
    result.users_scanned += 1;
    const prefs = prefsByUser.get(userId) ?? ALL_ON;
    try {
      const tz = await getUserTimezone(sb, userId);
      const rows = await fetchUserRows(sb, userId, sinceIso);
      const routines = computeHabitRoutines(rows, prefs, tz);
      const p = await persistRoutines(sb, userId, routines);
      result.routines_written += p.written;
      result.routines_deleted += p.deleted;
      if (await maybeWriteInsight(sb, userId, prefs, now)) result.insights_written += 1;
    } catch (err: any) {
      result.errors += 1;
      log(`rollup failed for ${userId.slice(0, 8)}…: ${err?.message}`);
    }
  }
  return result;
}
