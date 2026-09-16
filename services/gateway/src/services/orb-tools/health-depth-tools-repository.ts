// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references orb-tools/health-depth-tools.ts — zero coverage
// today.
/**
 * orb-tools/health-depth-tools.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * orb-tools/health-depth-tools.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same columns,
 * same conditional-filter logic, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param) — tools receive
 * their client per-call, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTenantIdForUser(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).limit(1).maybeSingle();
}

export async function fetchVitanaIndexScoreTotal(sb: SupabaseClient, userId: string, date: string) {
  return sb.from('vitana_index_scores').select('score_total').eq('user_id', userId).eq('date', date).maybeSingle();
}

export function upsertHealthFeatureDaily(
  sb: SupabaseClient,
  row: {
    tenant_id: string;
    user_id: string;
    date: string;
    feature_key: string;
    feature_value: number;
    feature_unit: string;
    sample_count: number;
    confidence: number;
    metadata: Record<string, unknown>;
  },
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('health_features_daily').upsert(row, { onConflict: 'tenant_id,user_id,date,feature_key' });
}

export function upsertUserIntegrationManualEntry(sb: SupabaseClient, userId: string): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('user_integrations').upsert(
    {
      user_id: userId,
      integration_id: 'manual-entry',
      status: 'connected',
      connected_at: new Date().toISOString(),
      last_sync_at: new Date().toISOString(),
      metadata: { source: 'voice_tool' },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,integration_id' },
  );
}

export async function computeVitanaIndexForUser(sb: SupabaseClient, userId: string, date: string) {
  return sb.rpc('health_compute_vitana_index_for_user', { p_user_id: userId, p_date: date });
}

export async function fetchHealthFeatureValue(sb: SupabaseClient, tenantId: string, userId: string, date: string, featureKey: string) {
  return sb
    .from('health_features_daily')
    .select('feature_value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('date', date)
    .eq('feature_key', featureKey)
    .maybeSingle();
}

export function insertWearableSamples(
  sb: SupabaseClient,
  rows: Array<{ tenant_id: string; user_id: string; provider: string; metric: string; ts: string; value: number; unit: string }>,
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('wearable_samples').insert(rows);
}

export async function insertLabReport(sb: SupabaseClient, tenantId: string, userId: string, reportDate: string) {
  return sb.from('lab_reports').insert({ tenant_id: tenantId, user_id: userId, source: 'voice', report_date: reportDate }).select('id').single();
}

export function insertBiomarkerResult(
  sb: SupabaseClient,
  row: {
    tenant_id: string;
    user_id: string;
    lab_report_id: string;
    biomarker_code: string | null;
    name: string;
    value: number;
    unit: string | null;
    ref_range_low: number | null;
    ref_range_high: number | null;
    status: string | null;
    measured_at: string;
  },
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('biomarker_results').insert(row);
}

export async function fetchVitanaIndexScoresHistory(sb: SupabaseClient, userId: string, fromDate: string) {
  return sb
    .from('vitana_index_scores')
    .select('date, score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental')
    .eq('user_id', userId)
    .gte('date', fromDate)
    .order('date', { ascending: true });
}

export async function fetchDiaryStreak(sb: SupabaseClient, userId: string) {
  return sb.from('user_diary_streak').select('current_streak_days').eq('user_id', userId).maybeSingle();
}

export async function fetchPillarStreakDays(sb: SupabaseClient, userId: string, pillarKey: string) {
  return sb.rpc('vitana_pillar_streak_days', { p_user_id: userId, p_pillar_key: pillarKey });
}

export async function fetchBiomarkerResults(sb: SupabaseClient, userId: string, limit: number, query?: string) {
  let q = sb
    .from('biomarker_results')
    .select('name, biomarker_code, value, unit, ref_range_low, ref_range_high, status, measured_at')
    .eq('user_id', userId)
    .order('measured_at', { ascending: false })
    .limit(limit);
  if (query) q = q.or(`name.ilike.%${query}%,biomarker_code.ilike.%${query}%`);
  return q;
}

export async function upsertHealthPlan(
  sb: SupabaseClient,
  row: {
    user_id: string;
    plan_type: string;
    plan_data: Record<string, unknown>;
    ai_generated: boolean;
    generated_at: string;
    active: boolean;
    adherence_score: number;
    last_updated: string;
  },
) {
  return sb.from('user_health_plans').upsert(row, { onConflict: 'user_id,plan_type' }).select('id, plan_type').single();
}

export async function fetchActiveHealthPlans(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_health_plans')
    .select('id, plan_type, ai_generated, adherence_score, active, created_at')
    .eq('user_id', userId)
    .eq('active', true)
    .order('created_at', { ascending: false });
}

export async function fetchHealthPlansForProgress(sb: SupabaseClient, userId: string, planId?: string, planType?: string) {
  let q = sb
    .from('user_health_plans')
    .select('id, plan_type, adherence_score, created_at')
    .eq('user_id', userId)
    .eq('active', true);
  if (planId) q = q.eq('id', planId);
  else if (planType) q = q.eq('plan_type', planType);
  return q.order('created_at', { ascending: false }).limit(5);
}

export async function fetchPlanAdherenceLogs(sb: SupabaseClient, planId: string, userId: string) {
  return sb
    .from('plan_adherence_logs')
    .select('completed, logged_at')
    .eq('plan_id', planId)
    .eq('user_id', userId)
    .order('logged_at', { ascending: false })
    .limit(30);
}

export async function fetchNextBestActionCandidates(sb: SupabaseClient, userId: string) {
  return sb
    .from('autopilot_recommendations')
    .select('id, title, summary, action_description, contribution_vector, priority')
    .eq('user_id', userId)
    .in('status', ['pending', 'new', 'snoozed'])
    .not('contribution_vector', 'is', null)
    .order('priority', { ascending: false })
    .limit(50);
}
