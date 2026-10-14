/**
 * VTID-05165 (Health Hub Phase 1 / C2) — the two fact computations C2 ships
 * (plan Change 12, round-1 F7): pure functions, no I/O.
 *
 *   sleep_duration_vs_baseline — daily sleep minutes (`sleep_session`)
 *   activity_volume            — daily steps (`steps`)
 *
 * Each compares the member's recent 7-day mean with their OWN 30-day mean
 * (both windows end on the reference date, inclusive — the 30-day mean is the
 * member's own baseline and includes the recent week). Never a population
 * norm, never a clinical threshold.
 *
 * Minimum-data rule: at least MIN_RECENT_DAYS days with data in the recent
 * window and MIN_BASELINE_DAYS in the baseline window, and a positive
 * baseline; otherwise no fact. Direction: |change| < STABLE_BAND_PCT ->
 * 'stable', else 'higher' / 'lower'.
 */

import type { WellnessDirection, WellnessFact, WellnessFactCategory, WellnessFactKind } from './types';

export const RECENT_WINDOW_DAYS = 7;
export const BASELINE_WINDOW_DAYS = 30;
export const MIN_RECENT_DAYS = 4;
export const MIN_BASELINE_DAYS = 14;
export const STABLE_BAND_PCT = 5;

/** The S4 daily row fields a comparison reads. */
export interface DailyValueRow {
  date: string;
  code: string;
  value: number | null;
  unit: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `date` (YYYY-MM-DD) shifted by `days`. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

interface ComparisonSpec {
  kind: WellnessFactKind;
  category: WellnessFactCategory;
  code: string;
}

/**
 * One value per local date for `code` within [from, to] (rows with a null or
 * non-finite value are no data). A duplicate date keeps the first row.
 */
function valuesByDate(rows: readonly DailyValueRow[], code: string, from: string, to: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r || r.code !== code || typeof r.date !== 'string') continue;
    if (r.date < from || r.date > to) continue;
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) continue;
    if (!out.has(r.date)) out.set(r.date, r.value);
  }
  return out;
}

export function compareRecentToBaseline(spec: ComparisonSpec, rows: readonly DailyValueRow[], asOf: string): WellnessFact | null {
  const recentFrom = shiftDate(asOf, -(RECENT_WINDOW_DAYS - 1));
  const baselineFrom = shiftDate(asOf, -(BASELINE_WINDOW_DAYS - 1));
  const baseline = valuesByDate(rows, spec.code, baselineFrom, asOf);
  const recent = valuesByDate(rows, spec.code, recentFrom, asOf);
  if (recent.size < MIN_RECENT_DAYS || baseline.size < MIN_BASELINE_DAYS) return null;
  const recentMean = mean([...recent.values()]);
  const baselineMean = mean([...baseline.values()]);
  if (!(baselineMean > 0) || !Number.isFinite(recentMean)) return null;
  const changePct = ((recentMean - baselineMean) / baselineMean) * 100;
  const direction: WellnessDirection = Math.abs(changePct) < STABLE_BAND_PCT ? 'stable' : changePct > 0 ? 'higher' : 'lower';
  const unit = rows.find((r) => r && r.code === spec.code)?.unit ?? '';
  return {
    kind: spec.kind,
    category: spec.category,
    code: spec.code,
    unit,
    direction,
    recent_mean: round1(recentMean),
    baseline_mean: round1(baselineMean),
    change_pct: Math.round(changePct),
    recent_days: recent.size,
    baseline_days: baseline.size,
    recent_window: { from: recentFrom, to: asOf },
    baseline_window: { from: baselineFrom, to: asOf },
  };
}

/** Catalogue code (S2) each implemented comparison reads. */
export const SLEEP_DURATION_CODE = 'sleep_session';
export const ACTIVITY_VOLUME_CODE = 'steps';

export function sleepDurationVsBaseline(rows: readonly DailyValueRow[], asOf: string): WellnessFact | null {
  return compareRecentToBaseline({ kind: 'sleep_duration_vs_baseline', category: 'sleep', code: SLEEP_DURATION_CODE }, rows, asOf);
}

export function activityVolume(rows: readonly DailyValueRow[], asOf: string): WellnessFact | null {
  return compareRecentToBaseline({ kind: 'activity_volume', category: 'activity', code: ACTIVITY_VOLUME_CODE }, rows, asOf);
}
