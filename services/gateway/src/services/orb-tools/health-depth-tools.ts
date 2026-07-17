/**
 * A11 Health depth (community role) — 15 voice tools extending the existing
 * VTID-02753 structured health-logging chokepoint (services/gateway/src/
 * services/voice-tools/health-log.ts) and the Vitana Index compute stack
 * to cover meals, vitals, mood, biomarkers, trends, streaks, health plans,
 * conditions, education and "next best action".
 *
 * REUSE, not reinvention — every write/read below targets a table or RPC
 * that already exists and is already used by production code:
 *
 *   - health_features_daily   — the exact table tool_log_health()
 *     (voice-tools/health-log.ts) upserts to for log_water/log_sleep/
 *     log_exercise/log_meditation. Its allowed feature_key catalog per
 *     pillar (routes/integrations.ts PILLAR_FEATURE_KEYS) already includes
 *     'meal_log' (nutrition), 'mood_entry' (mental) and 'wearable_heart_rate'
 *     (exercise) — log_meal / log_mood / the heart-rate leg of log_vitals
 *     write here, then call health_compute_vitana_index_for_user() for the
 *     same delta math save_diary_entry/tool_log_health already do.
 *   - wearable_samples        — the free-metric raw-signal table backing
 *     POST /api/v1/health/wearables/ingest (health_ingest_wearable_samples
 *     RPC, routes/health.ts). No feature_key exists for weight or blood
 *     pressure in the Index scoring catalog, so those legs of log_vitals
 *     land here instead — honest: they're recorded, but don't move the
 *     Index (matches what a real BP cuff/scale sync would do today).
 *   - lab_reports + biomarker_results — the exact tables
 *     health_ingest_lab_report() (routes/health.ts POST /lab-reports/ingest)
 *     writes to. That RPC is SECURITY DEFINER keyed off auth.uid()/
 *     current_tenant_id() from a user-JWT Supabase client, which the shared
 *     `sb` handed to orb tools (service-role admin client, see
 *     routes/orb-tool.ts adminClient()) cannot satisfy — so log_biomarker /
 *     get_lab_results write and read the SAME two tables directly with
 *     explicit tenant_id/user_id, matching the RPC's column-for-column shape.
 *   - vitana_index_scores      — get_health_trends reads the same table
 *     useVitanaIndexHistory.ts (vitana-v1) and fetchVitanaIndexForProfiler
 *     read, so trend math matches the My Journey trajectory card exactly.
 *   - user_diary_streak (view) + vitana_pillar_streak_days() RPC —
 *     get_health_streaks combines the real diary-streak view
 *     (20260427090000_user_diary_streak_view.sql) with the per-pillar
 *     streak RPC the v3 Index compute function already calls for the
 *     streak sub-score, instead of the client-only localStorage streak in
 *     vitana-v1's useVitanaStreaks.ts (not a server concept).
 *   - user_health_plans + plan_adherence_logs — REAL tables (their
 *     migration lives in the vitana-v1 repo:
 *     supabase/migrations/20251031134344_...sql — same physical Supabase
 *     project the gateway's service-role client talks to) backing
 *     useHealthPlans.ts. generate_health_plan writes here; the frontend's
 *     LLM-authored version (supabase/functions/generate-personalized-plan)
 *     calls a Lovable-AI-gateway edge function with a LOVABLE_API_KEY the
 *     gateway does not hold and no gateway code today invokes Supabase Edge
 *     Functions server-side — so generate_health_plan here builds
 *     plan_data from the same PILLAR_ACTION_TEMPLATES library
 *     tool_create_index_improvement_plan already uses for its template
 *     fallback, and marks ai_generated:false. This is a REAL row in the
 *     real table, just not the LLM-personalized copy — documented honestly
 *     in the tool's spoken text.
 *   - autopilot_recommendations — get_next_best_action ranks the same
 *     table tool_create_index_improvement_plan and tool_activate_recommendation
 *     already read/write, so its result id can be hop straight into
 *     activate_recommendation.
 *   - getUserHealthContext() (services/user-health-context.ts) — the exact
 *     primitive already assembling active_conditions/allergies/medications
 *     from user_limitations + memory_facts for the marketplace/discover
 *     tools. list_my_conditions calls it instead of inventing a new
 *     "conditions" table (none exists).
 *   - computeRetrievalRouterDecision + buildContextPack — the same
 *     knowledge-hub retrieval stack orb-tools-shared.ts's private
 *     _runRetrievalSearch('search_knowledge', ...) uses (that helper isn't
 *     exported, so get_health_education calls the same two underlying
 *     modules directly rather than duplicating a table).
 *
 * Two tools are honest stubs (no backing table/RPC found anywhere in
 * supabase/migrations or the frontend's own migrations):
 *   - order_lab_test        — no lab_test_orders (or equivalent) table.
 *   - connect_health_device  is NOT a stub — it's a real navigate-only
 *     orb_directive (no DB write required), per the brief.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { fetchVitanaIndexForProfiler } from '../user-context-profiler';
import { getUserHealthContext } from '../user-health-context';
import {
  resolvePillarKey,
  PILLAR_ACTION_TEMPLATES,
  PILLAR_KEYS,
  type PillarKey,
} from '../../lib/vitana-pillars';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function authGate(tool: string, id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDateArg(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : todayIso();
}

/** Tenant resolution mirrors voice-tools/health-log.ts (user_tenants, zero-UUID fallback). */
async function resolveHealthTenantId(id: OrbToolIdentity, sb: SupabaseClient): Promise<string> {
  if (id.tenant_id) return id.tenant_id;
  try {
    const { data } = await sb
      .from('user_tenants')
      .select('tenant_id')
      .eq('user_id', id.user_id)
      .limit(1)
      .maybeSingle();
    return (data as { tenant_id?: string } | null)?.tenant_id ?? DEFAULT_TENANT_ID;
  } catch {
    return DEFAULT_TENANT_ID;
  }
}

const PILLAR_SCORE_COLUMN: Record<PillarKey, string> = {
  nutrition: 'score_nutrition',
  hydration: 'score_hydration',
  exercise: 'score_exercise',
  sleep: 'score_sleep',
  mental: 'score_mental',
};

/**
 * Upsert one health_features_daily row (same shape as
 * voice-tools/health-log.ts's logHealthSignal) and recompute the Vitana
 * Index so the caller gets pillar_score_after / index_delta. Used by
 * log_meal, log_mood, and the heart-rate leg of log_vitals — the three new
 * verbs that map onto a real PILLAR_FEATURE_KEYS entry
 * (routes/integrations.ts) but aren't in tool_log_health's fixed
 * log_water/log_sleep/log_exercise/log_meditation union.
 */
async function upsertHealthFeatureAndRecompute(
  sb: SupabaseClient,
  id: OrbToolIdentity,
  opts: {
    date: string;
    featureKey: string;
    pillar: PillarKey;
    value: number;
    unit: string;
    metadata: Record<string, unknown>;
  },
): Promise<{ ok: true; pillarScoreAfter: number | null; totalAfter: number | null; indexDelta: number | null } | { ok: false; error: string }> {
  const tenantId = await resolveHealthTenantId(id, sb);

  const { data: prevRow } = await sb
    .from('vitana_index_scores')
    .select('score_total')
    .eq('user_id', id.user_id)
    .eq('date', opts.date)
    .maybeSingle();
  const prevTotal = (prevRow as { score_total?: number } | null)?.score_total ?? null;

  const { error: featErr } = await sb.from('health_features_daily').upsert(
    {
      tenant_id: tenantId,
      user_id: id.user_id,
      date: opts.date,
      feature_key: opts.featureKey,
      feature_value: opts.value,
      feature_unit: opts.unit,
      sample_count: 1,
      confidence: 0.85,
      metadata: opts.metadata,
    },
    { onConflict: 'tenant_id,user_id,date,feature_key' },
  );
  if (featErr) return { ok: false, error: `feature_write_failed: ${featErr.message}` };

  // Mark manual-entry integration connected (mirrors logHealthSignal / manual/log).
  try {
    await sb.from('user_integrations').upsert(
      {
        user_id: id.user_id,
        integration_id: 'manual-entry',
        status: 'connected',
        connected_at: new Date().toISOString(),
        last_sync_at: new Date().toISOString(),
        metadata: { source: 'voice_tool' },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,integration_id' },
    );
  } catch {
    /* non-fatal — mirrors health-log.ts */
  }

  const { data: newRow } = await sb.rpc('health_compute_vitana_index_for_user', {
    p_user_id: id.user_id,
    p_date: opts.date,
  });
  const r = newRow as Record<string, unknown> | null;
  const newTotal = typeof r?.score_total === 'number' ? r.score_total : null;
  const pillarCol = PILLAR_SCORE_COLUMN[opts.pillar];
  const pillarScoreAfter = typeof r?.[pillarCol] === 'number' ? (r[pillarCol] as number) : null;

  return {
    ok: true,
    pillarScoreAfter,
    totalAfter: newTotal,
    indexDelta: newTotal !== null && prevTotal !== null ? newTotal - prevTotal : null,
  };
}

// ---------------------------------------------------------------------------
// 1. log_meal
// ---------------------------------------------------------------------------

export async function tool_log_meal(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('log_meal', id);
  if (gate) return gate;
  const description = String(args.description ?? args.meal ?? '').trim();
  const mealType = String(args.meal_type ?? '').trim().toLowerCase() || null;
  const calories = typeof args.calories === 'number' ? args.calories : null;
  const date = parseDateArg(args.date);

  try {
    // meal_log is a COUNT feature (routes/integrations.ts PILLAR_FEATURE_KEYS.nutrition
    // includes 'meal_log'; diary-health-extractor.ts documents it the same way) —
    // read-modify-write so multiple meals in a day accumulate rather than overwrite.
    const tenantId = await resolveHealthTenantId(id, sb);
    const { data: existing } = await sb
      .from('health_features_daily')
      .select('feature_value')
      .eq('tenant_id', tenantId)
      .eq('user_id', id.user_id)
      .eq('date', date)
      .eq('feature_key', 'meal_log')
      .maybeSingle();
    const newCount = (Number((existing as { feature_value?: number } | null)?.feature_value) || 0) + 1;

    const out = await upsertHealthFeatureAndRecompute(sb, id, {
      date,
      featureKey: 'meal_log',
      pillar: 'nutrition',
      value: newCount,
      unit: 'meal',
      metadata: { description: description || null, meal_type: mealType, calories, source: 'voice_tool' },
    });
    if (!out.ok) return { ok: false, error: out.error };

    const deltaText = out.indexDelta !== null && out.indexDelta > 0 ? ` Vitana Index up ${out.indexDelta}.` : '';
    return {
      ok: true,
      result: { date, meal_count_today: newCount, meal_type: mealType, description, pillar_score_after: out.pillarScoreAfter, index_delta: out.indexDelta },
      text: `Logged ${mealType ? `your ${mealType}` : 'that meal'}${description ? ` (${description.slice(0, 80)})` : ''} — meal ${newCount} today.${deltaText}`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'log_meal failed' };
  }
}

// ---------------------------------------------------------------------------
// 2. log_vitals
// ---------------------------------------------------------------------------

export async function tool_log_vitals(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('log_vitals', id);
  if (gate) return gate;
  const date = parseDateArg(args.date);
  const heartRate = typeof args.heart_rate === 'number' ? args.heart_rate : null;
  const weightKg = typeof args.weight_kg === 'number' ? args.weight_kg : null;
  const systolic = typeof args.systolic === 'number' ? args.systolic : null;
  const diastolic = typeof args.diastolic === 'number' ? args.diastolic : null;

  if (heartRate === null && weightKg === null && systolic === null && diastolic === null) {
    return { ok: false, error: 'log_vitals requires at least one of heart_rate, weight_kg, systolic/diastolic.' };
  }

  const logged: string[] = [];
  let indexDelta: number | null = null;

  try {
    const tenantId = await resolveHealthTenantId(id, sb);
    const nowIso = new Date().toISOString();

    // Heart rate maps onto a REAL Index feature_key (exercise pillar's
    // 'wearable_heart_rate', per routes/integrations.ts PILLAR_FEATURE_KEYS) —
    // so it lands in health_features_daily and moves the Index, exactly like
    // a wearable sync would.
    if (heartRate !== null) {
      const out = await upsertHealthFeatureAndRecompute(sb, id, {
        date,
        featureKey: 'wearable_heart_rate',
        pillar: 'exercise',
        value: heartRate,
        unit: 'bpm',
        metadata: { source: 'voice_tool_vitals' },
      });
      if (!out.ok) return { ok: false, error: out.error };
      indexDelta = out.indexDelta;
      logged.push(`heart rate ${heartRate} bpm`);
    }

    // Weight and blood pressure have no Index feature_key today (only
    // biomarker_glucose/hba1c, meal_log, macro_balance exist for nutrition;
    // no weight/BP slot exists anywhere in the pillar catalog) — they go to
    // wearable_samples, the same free-metric raw-signal table
    // health_ingest_wearable_samples (routes/health.ts) writes to. Honest:
    // recorded, but does not move the Vitana Index (same as a real scale
    // sync with no matching feature_key would behave).
    const wearableRows: Array<{ tenant_id: string; user_id: string; provider: string; metric: string; ts: string; value: number; unit: string }> = [];
    if (weightKg !== null) {
      wearableRows.push({ tenant_id: tenantId, user_id: id.user_id, provider: 'manual_voice', metric: 'weight_kg', ts: nowIso, value: weightKg, unit: 'kg' });
      logged.push(`weight ${weightKg} kg`);
    }
    if (systolic !== null) {
      wearableRows.push({ tenant_id: tenantId, user_id: id.user_id, provider: 'manual_voice', metric: 'blood_pressure_systolic', ts: nowIso, value: systolic, unit: 'mmHg' });
      logged.push(`systolic ${systolic}`);
    }
    if (diastolic !== null) {
      wearableRows.push({ tenant_id: tenantId, user_id: id.user_id, provider: 'manual_voice', metric: 'blood_pressure_diastolic', ts: nowIso, value: diastolic, unit: 'mmHg' });
      logged.push(`diastolic ${diastolic}`);
    }
    if (wearableRows.length > 0) {
      const { error: wErr } = await sb.from('wearable_samples').insert(wearableRows);
      if (wErr) return { ok: false, error: `wearable_write_failed: ${wErr.message}` };
    }

    const deltaText = indexDelta !== null && indexDelta > 0 ? ` Vitana Index up ${indexDelta}.` : '';
    return {
      ok: true,
      result: { date, heart_rate: heartRate, weight_kg: weightKg, systolic, diastolic, index_delta: indexDelta },
      text: `Logged ${logged.join(', ')}.${deltaText}`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'log_vitals failed' };
  }
}

// ---------------------------------------------------------------------------
// 3. log_mood
// ---------------------------------------------------------------------------

const MOOD_LABEL_SCORE: Record<string, number> = {
  terrible: 1, bad: 2, down: 2, okay: 3, neutral: 3, fine: 3, good: 4, great: 5, fantastic: 5,
};

export async function tool_log_mood(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('log_mood', id);
  if (gate) return gate;
  const date = parseDateArg(args.date);
  const label = String(args.mood_label ?? '').trim().toLowerCase();
  let score = typeof args.mood_score === 'number' ? args.mood_score : null;
  if (score === null && label && MOOD_LABEL_SCORE[label] !== undefined) score = MOOD_LABEL_SCORE[label];
  if (score === null) {
    return { ok: false, error: 'log_mood requires mood_score (1-5) or a recognizable mood_label.' };
  }
  score = Math.max(1, Math.min(5, Math.round(score)));
  const notes = String(args.notes ?? '').trim();

  try {
    // 'mood_entry' is a real mental-pillar feature_key (routes/integrations.ts
    // PILLAR_FEATURE_KEYS.mental) — same chokepoint as log_meditation.
    const out = await upsertHealthFeatureAndRecompute(sb, id, {
      date,
      featureKey: 'mood_entry',
      pillar: 'mental',
      value: score,
      unit: 'score_1_5',
      metadata: { mood_label: label || null, notes: notes || null, source: 'voice_tool' },
    });
    if (!out.ok) return { ok: false, error: out.error };
    const deltaText = out.indexDelta !== null && out.indexDelta > 0 ? ` Vitana Index up ${out.indexDelta}.` : '';
    return {
      ok: true,
      result: { date, mood_score: score, mood_label: label || null, pillar_score_after: out.pillarScoreAfter, index_delta: out.indexDelta },
      text: `Logged your mood at ${score} out of 5${label ? ` (${label})` : ''}.${deltaText}`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'log_mood failed' };
  }
}

// ---------------------------------------------------------------------------
// 4. log_biomarker
// ---------------------------------------------------------------------------

export async function tool_log_biomarker(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('log_biomarker', id);
  if (gate) return gate;
  const name = String(args.name ?? '').trim();
  const value = typeof args.value === 'number' ? args.value : Number(args.value);
  if (!name || !Number.isFinite(value)) {
    return { ok: false, error: 'log_biomarker requires a biomarker name and a numeric value.' };
  }
  const unit = String(args.unit ?? '').trim() || null;
  const biomarkerCode = String(args.biomarker_code ?? '').trim() || null;
  const refLow = typeof args.ref_range_low === 'number' ? args.ref_range_low : null;
  const refHigh = typeof args.ref_range_high === 'number' ? args.ref_range_high : null;
  const measuredAt = typeof args.measured_at === 'string' && args.measured_at ? args.measured_at : new Date().toISOString();
  let status = String(args.status ?? '').trim().toLowerCase() || null;
  if (!status && refLow !== null && refHigh !== null) {
    status = value < refLow ? 'low' : value > refHigh ? 'high' : 'normal';
  }

  try {
    // Same two tables health_ingest_lab_report() (routes/health.ts) writes
    // to — that RPC needs a user-JWT client (current_user_id()/
    // current_tenant_id()), so we insert directly with the service-role `sb`
    // using the identical column shape (lab_reports -> biomarker_results).
    const tenantId = await resolveHealthTenantId(id, sb);
    const { data: labReport, error: labErr } = await sb
      .from('lab_reports')
      .insert({
        tenant_id: tenantId,
        user_id: id.user_id,
        source: 'voice',
        report_date: todayIso(),
      })
      .select('id')
      .single();
    if (labErr || !labReport) return { ok: false, error: labErr?.message ?? 'lab_reports insert failed' };

    const { error: bmErr } = await sb.from('biomarker_results').insert({
      tenant_id: tenantId,
      user_id: id.user_id,
      lab_report_id: (labReport as { id: string }).id,
      biomarker_code: biomarkerCode,
      name,
      value,
      unit,
      ref_range_low: refLow,
      ref_range_high: refHigh,
      status,
      measured_at: measuredAt,
    });
    if (bmErr) return { ok: false, error: bmErr.message };

    const statusPhrase = status ? ` — ${status}` : '';
    return {
      ok: true,
      result: { name, value, unit, status, measured_at: measuredAt },
      text: `Recorded ${name}: ${value}${unit ? ` ${unit}` : ''}${statusPhrase}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'log_biomarker failed' };
  }
}

// ---------------------------------------------------------------------------
// 5. get_health_trends
// ---------------------------------------------------------------------------

export async function tool_get_health_trends(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('get_health_trends', id);
  if (gate) return gate;
  const days = typeof args.days === 'number' ? Math.min(90, Math.max(3, Math.round(args.days))) : 14;
  const from = new Date();
  from.setDate(from.getDate() - days);
  const fromDate = from.toISOString().slice(0, 10);

  try {
    // Same table + shape as vitana-v1's useVitanaIndexHistory.ts / useVitanaIndex.ts
    // and user-context-profiler.ts's fetchVitanaIndex — trend math matches the
    // My Journey trajectory card exactly.
    const { data, error } = await sb
      .from('vitana_index_scores')
      .select('date, score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental')
      .eq('user_id', id.user_id)
      .gte('date', fromDate)
      .order('date', { ascending: true });
    if (error) return { ok: false, error: error.message };
    const rows = (data as Array<Record<string, number | string>>) ?? [];
    if (rows.length === 0) {
      return { ok: true, result: { history: [] }, text: `No Vitana Index history in the last ${days} days yet.` };
    }

    const first = rows[0];
    const last = rows[rows.length - 1];
    const trendFor = (col: string): 'up' | 'down' | 'stable' => {
      const a = Number(first[col]) || 0;
      const b = Number(last[col]) || 0;
      if (b > a + 5) return 'up';
      if (b < a - 5) return 'down';
      return 'stable';
    };
    const pillarTrends: Record<PillarKey, 'up' | 'down' | 'stable'> = {
      nutrition: trendFor('score_nutrition'),
      hydration: trendFor('score_hydration'),
      exercise: trendFor('score_exercise'),
      sleep: trendFor('score_sleep'),
      mental: trendFor('score_mental'),
    };
    const totalTrend = trendFor('score_total');
    const rising = PILLAR_KEYS.filter((p) => pillarTrends[p] === 'up');
    const falling = PILLAR_KEYS.filter((p) => pillarTrends[p] === 'down');

    let text = `Over the last ${days} days your Vitana Index total is ${totalTrend === 'up' ? 'trending up' : totalTrend === 'down' ? 'trending down' : 'holding steady'} (${first.score_total} → ${last.score_total}).`;
    if (rising.length) text += ` ${rising.join(', ')} improving.`;
    if (falling.length) text += ` ${falling.join(', ')} declining.`;

    return {
      ok: true,
      result: {
        days,
        history: rows.map((r) => ({ date: r.date, score_total: r.score_total })),
        total_trend: totalTrend,
        pillar_trends: pillarTrends,
        first: { date: first.date, score_total: first.score_total },
        last: { date: last.date, score_total: last.score_total },
      },
      text,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_health_trends failed' };
  }
}

// ---------------------------------------------------------------------------
// 6. get_health_streaks
// ---------------------------------------------------------------------------

export async function tool_get_health_streaks(_args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('get_health_streaks', id);
  if (gate) return gate;
  try {
    // Diary streak: real view (20260427090000_user_diary_streak_view.sql).
    let diaryStreak = 0;
    try {
      const { data } = await sb
        .from('user_diary_streak')
        .select('current_streak_days')
        .eq('user_id', id.user_id)
        .maybeSingle();
      diaryStreak = Number((data as { current_streak_days?: number } | null)?.current_streak_days) || 0;
    } catch {
      /* view may be absent in some envs — non-fatal */
    }

    // Per-pillar streaks: same RPC the v3 Index compute function calls for
    // the streak sub-score (vitana_pillar_streak_days).
    const pillarStreaks: Partial<Record<PillarKey, number>> = {};
    for (const pillar of PILLAR_KEYS) {
      try {
        const { data } = await sb.rpc('vitana_pillar_streak_days', { p_user_id: id.user_id, p_pillar_key: pillar });
        pillarStreaks[pillar] = Number(data) || 0;
      } catch {
        pillarStreaks[pillar] = 0;
      }
    }

    const bestPillarEntry = (Object.entries(pillarStreaks) as Array<[PillarKey, number]>).sort((a, b) => b[1] - a[1])[0];
    const bestPillar = bestPillarEntry?.[0];
    const bestPillarDays = bestPillarEntry?.[1] ?? 0;

    let text = '';
    if (diaryStreak > 0) text += `Your diary streak is ${diaryStreak} day${diaryStreak === 1 ? '' : 's'}. `;
    if (bestPillar && bestPillarDays > 0) {
      text += `Your longest active pillar streak is ${bestPillar} at ${bestPillarDays} day${bestPillarDays === 1 ? '' : 's'}.`;
    } else if (!text) {
      text = "No active streaks yet — log something today to start one.";
    }

    return {
      ok: true,
      result: { diary_streak_days: diaryStreak, pillar_streaks: pillarStreaks },
      text: text.trim(),
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_health_streaks failed' };
  }
}

// ---------------------------------------------------------------------------
// 7. order_lab_test — STUB. No lab_test_orders (or equivalent) table/RPC
// exists anywhere in supabase/migrations or the frontend's own migrations.
// Fabricating an ordering flow with no backend would silently lie to the
// user about a lab test actually being placed, so this returns ok:false
// per the hard rule against inventing tables.
// ---------------------------------------------------------------------------

export async function tool_order_lab_test(_args: OrbToolArgs, id: OrbToolIdentity, _sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('order_lab_test', id);
  if (gate) return gate;
  return { ok: false, error: 'order_lab_test is not available yet — no backing endpoint (no lab_test_orders table or ordering RPC exists).' };
}

// ---------------------------------------------------------------------------
// 8. get_lab_results
// ---------------------------------------------------------------------------

export async function tool_get_lab_results(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('get_lab_results', id);
  if (gate) return gate;
  const query = String(args.biomarker ?? args.query ?? '').trim();
  const limit = typeof args.limit === 'number' ? Math.min(25, Math.max(1, Math.round(args.limit))) : 10;

  try {
    let q = sb
      .from('biomarker_results')
      .select('name, biomarker_code, value, unit, ref_range_low, ref_range_high, status, measured_at')
      .eq('user_id', id.user_id)
      .order('measured_at', { ascending: false })
      .limit(limit);
    if (query) q = q.or(`name.ilike.%${query}%,biomarker_code.ilike.%${query}%`);
    const { data, error } = await q;
    if (error) return { ok: false, error: error.message };
    const rows = (data as Array<Record<string, unknown>>) ?? [];
    if (rows.length === 0) {
      return {
        ok: true,
        result: { results: [] },
        text: query ? `No lab results found matching "${query}".` : 'No lab results on file yet.',
      };
    }
    const lines = rows
      .slice(0, 8)
      .map((r) => `${r.name}: ${r.value}${r.unit ? ` ${r.unit}` : ''}${r.status ? ` (${r.status})` : ''}`)
      .join('; ');
    return {
      ok: true,
      result: { results: rows },
      text: `Latest lab results: ${lines}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_lab_results failed' };
  }
}

// ---------------------------------------------------------------------------
// 9. generate_health_plan (⚠️ two-step confirm; template-based — see file
// header for why this isn't the LLM-authored version the app UI produces)
// ---------------------------------------------------------------------------

export async function tool_generate_health_plan(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('generate_health_plan', id);
  if (gate) return gate;
  try {
    let pillar = resolvePillarKey(args.plan_type as string | undefined);
    if (!pillar) {
      const snap = await fetchVitanaIndexForProfiler(sb, id.user_id);
      pillar = snap?.weakest_pillar?.name;
    }
    if (!pillar) {
      return {
        ok: true,
        result: { ok: false, reason: 'no_index_data' },
        text: "I don't have Index data for you yet, so I can't target a plan. Complete the baseline survey first, or tell me which area to focus on.",
      };
    }

    const templates = PILLAR_ACTION_TEMPLATES[pillar];
    const planData = {
      planName: `${pillar[0].toUpperCase()}${pillar.slice(1)} starter plan`,
      duration: '14 days',
      goals: templates.map((t) => t.title),
      dailyPlan: { focus: pillar, actions: templates.map((t) => ({ title: t.title, description: t.description })) },
      recommendations: templates.map((t) => t.description),
    };

    const confirm = args.confirm === true || args.confirm === 'true';
    if (!confirm) {
      return {
        ok: true,
        result: { needs_confirmation: true, plan_type: pillar, preview: planData },
        text: `Confirm with the user: create a ${pillar} health plan with ${templates.length} template actions (this is a starter template, not an AI-personalized plan — say yes to save it)? When they agree, call generate_health_plan again with plan_type:"${pillar}" and confirm:true.`,
      };
    }

    // Same table useHealthPlans.ts reads (supabase.from('user_health_plans')),
    // upserted the same way the generate-personalized-plan edge function does
    // (onConflict user_id,plan_type) — but ai_generated:false since the
    // gateway cannot reach the Lovable-AI-backed edge function (see file header).
    const { data: saved, error } = await sb
      .from('user_health_plans')
      .upsert(
        {
          user_id: id.user_id,
          plan_type: pillar,
          plan_data: planData,
          ai_generated: false,
          generated_at: new Date().toISOString(),
          active: true,
          adherence_score: 0,
          last_updated: new Date().toISOString(),
        },
        { onConflict: 'user_id,plan_type' },
      )
      .select('id, plan_type')
      .single();
    if (error || !saved) return { ok: false, error: error?.message ?? 'user_health_plans upsert failed' };

    return {
      ok: true,
      result: { plan_id: (saved as { id: string }).id, plan_type: pillar, plan_data: planData },
      text: `Saved a ${pillar} starter plan with ${templates.length} actions. You can track adherence with "how's my plan going".`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'generate_health_plan failed' };
  }
}

// ---------------------------------------------------------------------------
// 10. list_my_health_plans
// ---------------------------------------------------------------------------

export async function tool_list_my_health_plans(_args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('list_my_health_plans', id);
  if (gate) return gate;
  try {
    const { data, error } = await sb
      .from('user_health_plans')
      .select('id, plan_type, ai_generated, adherence_score, active, created_at')
      .eq('user_id', id.user_id)
      .eq('active', true)
      .order('created_at', { ascending: false });
    if (error) return { ok: false, error: error.message };
    const rows = (data as Array<Record<string, unknown>>) ?? [];
    if (rows.length === 0) {
      return { ok: true, result: { plans: [] }, text: "You don't have any active health plans yet. Want me to create one?" };
    }
    const lines = rows.map((r) => `${r.plan_type} (${r.adherence_score ?? 0}% adherence)`).join(', ');
    return {
      ok: true,
      result: { plans: rows },
      text: `Your active health plans: ${lines}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'list_my_health_plans failed' };
  }
}

// ---------------------------------------------------------------------------
// 11. get_health_plan_progress
// ---------------------------------------------------------------------------

export async function tool_get_health_plan_progress(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('get_health_plan_progress', id);
  if (gate) return gate;
  const planType = resolvePillarKey(args.plan_type as string | undefined);
  const planId = String(args.plan_id ?? '').trim();

  try {
    let planQuery = sb
      .from('user_health_plans')
      .select('id, plan_type, adherence_score, created_at')
      .eq('user_id', id.user_id)
      .eq('active', true);
    if (planId) planQuery = planQuery.eq('id', planId);
    else if (planType) planQuery = planQuery.eq('plan_type', planType);
    const { data: plans, error: planErr } = await planQuery.order('created_at', { ascending: false }).limit(5);
    if (planErr) return { ok: false, error: planErr.message };
    const candidates = (plans as Array<Record<string, unknown>>) ?? [];
    if (candidates.length === 0) {
      return { ok: true, result: { found: false }, text: "I couldn't find an active plan matching that. Say 'list my health plans' to see what's active." };
    }
    if (candidates.length > 1) {
      return {
        ok: true,
        result: { candidates: candidates.map((p) => ({ plan_id: p.id, plan_type: p.plan_type })) },
        text: `You have ${candidates.length} active plans: ${candidates.map((p) => p.plan_type).join(', ')}. Which one?`,
      };
    }
    const plan = candidates[0] as { id: string; plan_type: string; adherence_score: number | null };

    // plan_adherence_logs — same table useHealthPlans.ts's logAdherence writes to.
    const { data: logs, error: logErr } = await sb
      .from('plan_adherence_logs')
      .select('completed, logged_at')
      .eq('plan_id', plan.id)
      .eq('user_id', id.user_id)
      .order('logged_at', { ascending: false })
      .limit(30);
    if (logErr) return { ok: false, error: logErr.message };
    const logRows = (logs as Array<{ completed: boolean; logged_at: string }>) ?? [];
    const completedCount = logRows.filter((l) => l.completed).length;
    const rate = logRows.length > 0 ? Math.round((completedCount / logRows.length) * 100) : null;

    return {
      ok: true,
      result: {
        plan_id: plan.id,
        plan_type: plan.plan_type,
        adherence_score: plan.adherence_score,
        recent_log_count: logRows.length,
        recent_completed: completedCount,
        recent_completion_rate_pct: rate,
      },
      text:
        logRows.length > 0
          ? `Your ${plan.plan_type} plan: ${completedCount} of ${logRows.length} recent check-ins completed (${rate}%). Stored adherence score is ${plan.adherence_score ?? 0}%.`
          : `Your ${plan.plan_type} plan has an adherence score of ${plan.adherence_score ?? 0}% but no logged check-ins yet.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_health_plan_progress failed' };
  }
}

// ---------------------------------------------------------------------------
// 12. list_my_conditions
// ---------------------------------------------------------------------------

export async function tool_list_my_conditions(_args: OrbToolArgs, id: OrbToolIdentity, _sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('list_my_conditions', id);
  if (gate) return gate;
  try {
    // Same primitive search_marketplace_products / open_discover_feed already
    // use (services/user-health-context.ts) — assembles active_conditions
    // from user_limitations.contraindications + memory_facts, instead of a
    // dedicated (nonexistent) "conditions" table.
    const ctx = await getUserHealthContext(id.user_id, { include_wearable: false, include_calendar: false, include_past_purchases: false });
    const conditions = ctx.active_conditions.map((c) => c.key);
    if (conditions.length === 0 && ctx.allergies.length === 0 && ctx.current_medications.length === 0) {
      return {
        ok: true,
        result: { conditions: [], allergies: [], medications: [] },
        text: "You don't have any conditions, allergies, or medications on file yet. You can add them in Preferences.",
      };
    }
    const parts: string[] = [];
    if (conditions.length) parts.push(`conditions: ${conditions.join(', ')}`);
    if (ctx.allergies.length) parts.push(`allergies: ${ctx.allergies.join(', ')}`);
    if (ctx.current_medications.length) parts.push(`medications: ${ctx.current_medications.join(', ')}`);
    if (ctx.dietary_restrictions.length) parts.push(`dietary restrictions: ${ctx.dietary_restrictions.join(', ')}`);

    return {
      ok: true,
      result: {
        conditions,
        allergies: ctx.allergies,
        medications: ctx.current_medications,
        dietary_restrictions: ctx.dietary_restrictions,
      },
      text: `On file for you — ${parts.join('; ')}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'list_my_conditions failed' };
  }
}

// ---------------------------------------------------------------------------
// 13. get_health_education
// ---------------------------------------------------------------------------

export async function tool_get_health_education(args: OrbToolArgs, id: OrbToolIdentity, _sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('get_health_education', id);
  if (gate) return gate;
  const topic = String(args.topic ?? args.query ?? '').trim();
  if (!topic) return { ok: false, error: 'get_health_education requires a topic.' };
  if (!id.tenant_id) return { ok: false, error: 'get_health_education requires a tenant_id on the session.' };

  try {
    // Same knowledge-hub retrieval stack orb-tools-shared.ts's private
    // _runRetrievalSearch('search_knowledge', ...) uses — that helper isn't
    // exported, so we call the two underlying modules directly (forcing
    // knowledge_hub) rather than duplicating a table.
    const { computeRetrievalRouterDecision } = await import('../retrieval-router');
    const { buildContextPack } = await import('../context-pack-builder');
    const { createContextLens } = await import('../../types/context-lens');

    const query = `health education: ${topic}`;
    const routerDecision = computeRetrievalRouterDecision(query, {
      channel: 'orb',
      force_sources: ['knowledge_hub'],
      limit_overrides: { memory_garden: 0, knowledge_hub: 5, web_search: 0 },
    });
    const lens = createContextLens(id.tenant_id, id.user_id, { workspace_scope: 'product', active_role: id.role || undefined });
    const threadId = id.thread_id || id.session_id || `${id.user_id}:get_health_education`;
    const contextPack = await buildContextPack({
      lens,
      query,
      channel: 'orb',
      thread_id: threadId,
      turn_number: typeof id.turn_number === 'number' ? id.turn_number : 0,
      conversation_start: id.session_started_iso || new Date().toISOString(),
      role: id.role || 'user',
      router_decision: routerDecision,
    });

    const hits = (contextPack.knowledge_hits || []) as Array<{ title?: string; excerpt?: string; content?: string; citation?: string }>;
    if (hits.length === 0) {
      return { ok: true, result: { items: [] }, text: `I don't have grounded knowledge-base content on "${topic}" yet.` };
    }
    const MAX = 4000;
    let formatted = hits
      .slice(0, 4)
      .map((h) => `**${h.title || 'KB'}**\n${h.excerpt || h.content || ''}`)
      .join('\n\n');
    if (formatted.length > MAX) formatted = formatted.substring(0, MAX) + '\n... (truncated)';
    return {
      ok: true,
      result: { items: hits.slice(0, 4) },
      text: `Here's what I found on ${topic}:\n${formatted}`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_health_education failed' };
  }
}

// ---------------------------------------------------------------------------
// 14. get_next_best_action
// ---------------------------------------------------------------------------

export async function tool_get_next_best_action(_args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('get_next_best_action', id);
  if (gate) return gate;
  try {
    // Same table + ranking approach tool_create_index_improvement_plan and
    // tool_activate_recommendation already use — so the returned id can be
    // handed straight to activate_recommendation.
    const { data } = await sb
      .from('autopilot_recommendations')
      .select('id, title, summary, action_description, contribution_vector, priority')
      .eq('user_id', id.user_id)
      .in('status', ['pending', 'new', 'snoozed'])
      .not('contribution_vector', 'is', null)
      .order('priority', { ascending: false })
      .limit(50);

    const ranked = ((data as Array<Record<string, unknown>>) ?? [])
      .map((r) => {
        const cv = (r.contribution_vector as Record<string, number> | null) ?? {};
        const bestPillar = (PILLAR_KEYS as readonly string[])
          .map((p) => ({ pillar: p, lift: typeof cv[p] === 'number' ? cv[p] : 0 }))
          .sort((a, b) => b.lift - a.lift)[0];
        return { ...r, _lift: bestPillar?.lift ?? 0, _pillar: bestPillar?.pillar };
      })
      .filter((r) => r._lift > 0)
      .sort((a, b) => b._lift - a._lift);

    if (ranked.length > 0) {
      const top = ranked[0] as unknown as { id: string; title: string | null; summary: string | null; action_description: string | null; _pillar?: string };
      return {
        ok: true,
        result: { source: 'autopilot', id: top.id, title: top.title, pillar: top._pillar },
        text: `Today's next best health action: ${top.title ?? 'an autopilot suggestion'}${top.summary ? ` — ${top.summary}` : ''}. Want me to activate it?`,
      };
    }

    // Fallback: no queued autopilot recommendation with a pillar lift —
    // suggest the top template action for the weakest Vitana Index pillar
    // (same PILLAR_ACTION_TEMPLATES library the plan tool uses). This has
    // no autopilot_recommendations id, so it can't be handed to
    // activate_recommendation — it's a spoken suggestion only, and the
    // result says so explicitly (no fabricated id).
    const snap = await fetchVitanaIndexForProfiler(sb, id.user_id);
    if (!snap) {
      return { ok: true, result: { source: 'none' }, text: "I don't have a specific next action for you yet — log something today to get started." };
    }
    const pillar = snap.weakest_pillar.name;
    const template = PILLAR_ACTION_TEMPLATES[pillar][0];
    return {
      ok: true,
      result: { source: 'template_fallback', pillar, title: template.title, description: template.description },
      text: `No queued suggestions right now, but your weakest pillar is ${pillar} — try: ${template.title}. ${template.description}`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'get_next_best_action failed' };
  }
}

// ---------------------------------------------------------------------------
// 15. connect_health_device — navigate-only orb_directive, no DB write
// (device pairing is inherently a client-side/native flow).
// ---------------------------------------------------------------------------

export async function tool_connect_health_device(args: OrbToolArgs, id: OrbToolIdentity, _sb: SupabaseClient): Promise<OrbToolResult> {
  const gate = authGate('connect_health_device', id);
  if (gate) return gate;
  const deviceName = String(args.device_name ?? '').trim();
  // /health-tracker/devices and /health/my-health-tracker both redirect to
  // /health (vitana-v1/src/App.tsx) — that's where device connections live.
  const route = '/health';
  return {
    ok: true,
    result: {
      directive: { type: 'orb_directive', directive: 'navigate', screen_id: 'HEALTH.TRACKER', route, title: 'Health', reason: 'connect_health_device', vtid: 'A11-HEALTH-DEPTH' },
      redirect: { route },
    },
    text: `Opening your health tracker so you can pair${deviceName ? ` ${deviceName}` : ' your device'} — device connections are set up there.`,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const HEALTH_DEPTH_TOOL_HANDLERS: Record<string, Handler> = {
  log_meal: tool_log_meal,
  log_vitals: tool_log_vitals,
  log_mood: tool_log_mood,
  log_biomarker: tool_log_biomarker,
  get_health_trends: tool_get_health_trends,
  get_health_streaks: tool_get_health_streaks,
  order_lab_test: tool_order_lab_test,
  get_lab_results: tool_get_lab_results,
  generate_health_plan: tool_generate_health_plan,
  list_my_health_plans: tool_list_my_health_plans,
  get_health_plan_progress: tool_get_health_plan_progress,
  list_my_conditions: tool_list_my_conditions,
  get_health_education: tool_get_health_education,
  get_next_best_action: tool_get_next_best_action,
  connect_health_device: tool_connect_health_device,
};

export const HEALTH_DEPTH_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'log_meal',
    description: [
      'Log a meal (breakfast/lunch/dinner/snack) toward the nutrition pillar.',
      'CALL WHEN the user says: "I just had breakfast", "log my lunch",',
      '"ich habe gerade gegessen", "trage mein Mittagessen ein".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What was eaten, e.g. "oatmeal with berries".' },
        meal_type: { type: 'string', description: "One of breakfast, lunch, dinner, snack." },
        calories: { type: 'number', description: 'Optional estimated calories.' },
        date: { type: 'string', description: 'YYYY-MM-DD, defaults to today.' },
      },
      required: [],
    },
  },
  {
    name: 'log_vitals',
    description: [
      'Log vitals: heart rate, weight, and/or blood pressure. Pass any subset.',
      'Heart rate contributes to the Vitana Index exercise pillar; weight and',
      'blood pressure are recorded but do not currently move the Index.',
      'CALL WHEN the user says: "my heart rate is 68", "I weigh 74 kilos",',
      '"my blood pressure is 120 over 80", "meine Herzfrequenz ist ...".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        heart_rate: { type: 'number', description: 'Heart rate in bpm.' },
        weight_kg: { type: 'number', description: 'Body weight in kilograms.' },
        systolic: { type: 'number', description: 'Systolic blood pressure (mmHg).' },
        diastolic: { type: 'number', description: 'Diastolic blood pressure (mmHg).' },
        date: { type: 'string', description: 'YYYY-MM-DD, defaults to today.' },
      },
      required: [],
    },
  },
  {
    name: 'log_mood',
    description: [
      'Log a mental-health / mood check-in (1-5 scale, or a mood word).',
      'CALL WHEN the user says: "I feel great today", "log my mood as okay",',
      '"ich fühle mich heute gut".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        mood_score: { type: 'number', description: '1 (terrible) to 5 (fantastic).' },
        mood_label: { type: 'string', description: "A word like 'great', 'okay', 'down' — used if mood_score is omitted." },
        notes: { type: 'string', description: 'Optional short note about why.' },
        date: { type: 'string', description: 'YYYY-MM-DD, defaults to today.' },
      },
      required: [],
    },
  },
  {
    name: 'log_biomarker',
    description: [
      'Record a single lab/biomarker value the user reports out loud (e.g. from',
      'a home test or a doctor visit), creating a lab report entry.',
      'CALL WHEN the user says: "my glucose was 95", "my cholesterol came back',
      'at 180", "mein Blutzucker war 95".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Biomarker name, e.g. 'glucose', 'LDL cholesterol'." },
        value: { type: 'number', description: 'The measured value.' },
        unit: { type: 'string', description: "Unit, e.g. 'mg/dL'." },
        biomarker_code: { type: 'string', description: "Optional code, e.g. 'HBA1C'." },
        ref_range_low: { type: 'number', description: 'Optional reference range low.' },
        ref_range_high: { type: 'number', description: 'Optional reference range high.' },
        status: { type: 'string', description: "Optional: 'low'|'normal'|'high'|'critical' — inferred from range if omitted." },
        measured_at: { type: 'string', description: 'Optional ISO timestamp; defaults to now.' },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'get_health_trends',
    description: [
      'Get the Vitana Index trend (total + per-pillar) over a recent window.',
      'CALL WHEN the user asks: "how have I been trending?", "am I improving?",',
      '"wie hat sich mein Index entwickelt?".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Window size in days, default 14, max 90.' } },
      required: [],
    },
  },
  {
    name: 'get_health_streaks',
    description: [
      'Get the user\'s diary streak and per-pillar Vitana Index streaks.',
      'CALL WHEN the user asks: "what\'s my streak?", "am I on a streak?",',
      '"wie lange ist meine Serie schon?".',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'order_lab_test',
    description: 'Order a lab test. NOT AVAILABLE YET — always returns an error explaining there is no ordering backend; tell the user this feature is not live yet.',
    parameters: { type: 'object', properties: { test_name: { type: 'string', description: 'Name of the test requested.' } }, required: [] },
  },
  {
    name: 'get_lab_results',
    description: [
      'Read the user\'s recorded lab/biomarker results, most recent first.',
      'CALL WHEN the user asks: "what were my last lab results?", "what\'s my',
      'cholesterol?", "wie waren meine letzten Laborwerte?".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        biomarker: { type: 'string', description: 'Optional biomarker name/code to filter by.' },
        limit: { type: 'number', description: 'Max results, default 10.' },
      },
      required: [],
    },
  },
  {
    name: 'generate_health_plan',
    description: [
      'Create a starter health plan (template-based, not AI-personalized) for a',
      'pillar. ALWAYS call once WITHOUT confirm first — the tool returns a',
      'preview; after the user agrees, call again with confirm:true.',
      'CALL WHEN the user says: "make me a nutrition plan", "erstelle einen',
      'Ernährungsplan für mich".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        plan_type: { type: 'string', description: 'One of nutrition, hydration, exercise, sleep, mental. Defaults to the weakest pillar.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user confirmed creating the plan.' },
      },
      required: [],
    },
  },
  {
    name: 'list_my_health_plans',
    description: 'List the user\'s active health plans with adherence scores. CALL WHEN the user asks: "what plans do I have?", "welche Pläne habe ich?".',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_health_plan_progress',
    description: [
      'Get adherence/progress for a specific active health plan.',
      'CALL WHEN the user asks: "how\'s my plan going?", "am I keeping up with',
      'my sleep plan?", "wie läuft mein Plan?".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        plan_type: { type: 'string', description: 'One of nutrition, hydration, exercise, sleep, mental.' },
        plan_id: { type: 'string', description: 'Exact plan UUID if known.' },
      },
      required: [],
    },
  },
  {
    name: 'list_my_conditions',
    description: [
      'List the user\'s recorded health conditions, allergies, medications, and',
      'dietary restrictions.',
      'CALL WHEN the user asks: "what conditions do I have on file?", "what',
      'are my allergies?", "welche Erkrankungen habe ich hinterlegt?".',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_health_education',
    description: [
      'Get grounded educational content on a health/longevity topic from the',
      'knowledge hub.',
      'CALL WHEN the user asks: "tell me about HRV", "what is VO2 max?",',
      '"erkläre mir was Schlafqualität bedeutet".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'The health topic to explain.' } },
      required: ['topic'],
    },
  },
  {
    name: 'get_next_best_action',
    description: [
      'Get today\'s single highest-priority recommended health action.',
      'CALL WHEN the user asks: "what should I do today?", "what\'s my next',
      'step?", "was soll ich heute für meine Gesundheit tun?".',
      'If the result has an autopilot id, offer to call activate_recommendation.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'connect_health_device',
    description: [
      'Start pairing a wearable/health device. Opens the health tracker screen',
      'where device connections are managed (pairing itself is a native/client flow).',
      'CALL WHEN the user says: "connect my Oura ring", "pair my device",',
      '"verbinde mein Gerät".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { device_name: { type: 'string', description: 'Optional device name, e.g. "Oura Ring".' } },
      required: [],
    },
  },
];
