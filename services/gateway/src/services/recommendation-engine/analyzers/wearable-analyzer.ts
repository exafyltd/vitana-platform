/**
 * VTID-02100: Wearable Analyzer — 9th analyzer.
 *
 * Reads the wearable_rollup_7d view. For each user with fresh data:
 *   - low 7-day sleep avg (< 6h)          -> insomnia recommendation
 *   - low HRV avg (< 40ms)                -> low-hrv / chronic-stress rec
 *   - low active_minutes (< 30/day)       -> low-energy nudge
 *   - no workouts in last 7d              -> post-workout-recovery /
 *                                            energy bundled nudge (deferred)
 *
 * Emits signals; convert to `source_type='marketplace'` downstream (reuses
 * the marketplace analyzer pipeline — condition_product_mappings drive the
 * actual product picks).
 */

import { createHash } from 'crypto';
import { getSupabase } from '../../../lib/supabase';

const LOG_PREFIX = '[VTID-02100:WearableAnalyzer]';

export interface WearableSignal {
  user_id: string;
  tenant_id: string | null;
  condition_key: string;              // canonical condition key (matches condition_product_mappings)
  severity: 'low' | 'medium' | 'high';
  confidence: number;                  // 0..1
  source_metrics: Record<string, number | null>;
  summary: string;                     // human-readable for autopilot card
}

export interface WearableAnalysisResult {
  ok: boolean;
  signals: WearableSignal[];
  summary: {
    users_analyzed: number;
    signals_generated: number;
    duration_ms: number;
  };
  error?: string;
}

interface RollupRow {
  user_id: string;
  sleep_avg_minutes: number | null;
  sleep_deep_avg_minutes: number | null;
  sleep_deep_pct: number | null;
  hrv_avg_ms: number | null;
  resting_hr: number | null;
  activity_minutes: number | null;
  workout_count: number | null;
  days_with_data: number;
  latest_date: string | null;
}

async function resolveTenantId(userId: string): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from('user_tenants')
    .select('tenant_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  return data?.tenant_id ?? null;
}

function classifySleep(r: RollupRow): WearableSignal | null {
  if (r.sleep_avg_minutes === null || r.days_with_data < 3) return null;
  if (r.sleep_avg_minutes < 360) {
    const hours = r.sleep_avg_minutes / 60;
    return {
      user_id: r.user_id,
      tenant_id: null,
      condition_key: 'insomnia',
      severity: r.sleep_avg_minutes < 300 ? 'high' : 'medium',
      confidence: Math.min(0.95, 0.5 + r.days_with_data * 0.06),
      source_metrics: {
        sleep_avg_minutes: r.sleep_avg_minutes,
        sleep_deep_avg_minutes: r.sleep_deep_avg_minutes,
        sleep_deep_pct: r.sleep_deep_pct,
        days_with_data: r.days_with_data,
      },
      summary: `Averaged ${hours.toFixed(1)}h sleep the last ${r.days_with_data} days — below the 7h+ baseline.`,
    };
  }
  // Low deep sleep proportion
  if (r.sleep_deep_pct !== null && r.sleep_deep_pct > 0 && r.sleep_deep_pct < 10) {
    return {
      user_id: r.user_id,
      tenant_id: null,
      condition_key: 'insomnia',
      severity: 'low',
      confidence: 0.5,
      source_metrics: { sleep_avg_minutes: r.sleep_avg_minutes, sleep_deep_pct: r.sleep_deep_pct },
      summary: `Deep sleep sitting at ${r.sleep_deep_pct.toFixed(1)}% — magnesium-glycinate is typically indicated.`,
    };
  }
  return null;
}

function classifyHrv(r: RollupRow): WearableSignal | null {
  if (r.hrv_avg_ms === null || r.days_with_data < 3) return null;
  if (r.hrv_avg_ms < 40) {
    return {
      user_id: r.user_id,
      tenant_id: null,
      condition_key: 'low-hrv',
      severity: r.hrv_avg_ms < 25 ? 'high' : 'medium',
      confidence: Math.min(0.9, 0.5 + r.days_with_data * 0.05),
      source_metrics: { hrv_avg_ms: r.hrv_avg_ms, resting_hr: r.resting_hr, days_with_data: r.days_with_data },
      summary: `HRV averaging ${r.hrv_avg_ms.toFixed(0)}ms — autonomic stress indicator. Omega-3 + breathwork are common first steps.`,
    };
  }
  return null;
}

function classifyActivity(r: RollupRow): WearableSignal | null {
  if (r.activity_minutes === null || r.days_with_data < 3) return null;
  if (r.activity_minutes < 20 && (r.workout_count ?? 0) === 0) {
    return {
      user_id: r.user_id,
      tenant_id: null,
      condition_key: 'low-energy',
      severity: 'low',
      confidence: 0.55,
      source_metrics: {
        activity_minutes: r.activity_minutes,
        workout_count: r.workout_count,
        days_with_data: r.days_with_data,
      },
      summary: `Activity under 20 min/day this week. A B-vitamin + vitamin-D check can support energy.`,
    };
  }
  return null;
}

export async function analyzeWearables(opts: {
  user_ids?: string[];
  limit?: number;
} = {}): Promise<WearableAnalysisResult> {
  const startTime = Date.now();
  const supabase = getSupabase();
  if (!supabase) {
    return {
      ok: false,
      signals: [],
      summary: { users_analyzed: 0, signals_generated: 0, duration_ms: 0 },
      error: 'Supabase unavailable',
    };
  }

  let query = supabase
    .from('wearable_rollup_7d')
    .select('*')
    .gte('days_with_data', 3)
    .limit(opts.limit ?? 500);
  if (opts.user_ids?.length) {
    query = query.in('user_id', opts.user_ids);
  }

  const { data, error } = await query;
  if (error) {
    return {
      ok: false,
      signals: [],
      summary: { users_analyzed: 0, signals_generated: 0, duration_ms: Date.now() - startTime },
      error: error.message,
    };
  }

  const rows = (data ?? []) as RollupRow[];
  const signals: WearableSignal[] = [];

  for (const r of rows) {
    const row_signals: WearableSignal[] = [];
    const sleep = classifySleep(r);
    if (sleep) row_signals.push(sleep);
    const hrv = classifyHrv(r);
    if (hrv) row_signals.push(hrv);
    const activity = classifyActivity(r);
    if (activity) row_signals.push(activity);

    if (row_signals.length > 0) {
      const tenantId = await resolveTenantId(r.user_id);
      for (const s of row_signals) {
        s.tenant_id = tenantId;
        signals.push(s);
      }
    }
  }

  const duration = Date.now() - startTime;
  console.log(
    `${LOG_PREFIX} analyzed ${rows.length} users, generated ${signals.length} signals in ${duration}ms`
  );

  return {
    ok: true,
    signals,
    summary: { users_analyzed: rows.length, signals_generated: signals.length, duration_ms: duration },
  };
}

export function generateWearableFingerprint(signal: WearableSignal): string {
  // Daily bucket so a user gets at most one wearable signal per condition per day
  const day = new Date().toISOString().slice(0, 10);
  const data = `wearable:${signal.user_id}:${signal.condition_key}:${day}`;
  return createHash('sha256').update(data).digest('hex').substring(0, 16);
}
