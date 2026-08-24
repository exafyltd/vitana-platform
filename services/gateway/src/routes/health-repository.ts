/**
 * routes/health.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in routes/health.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param) — the route receives its client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== RPCs ====================

export async function rpcMeContext(sb: SupabaseClient) {
  return sb.rpc('me_context');
}

export async function rpcHealthIngestLabReport(sb: SupabaseClient, payload: { p_provider: unknown; p_report_date: unknown; p_biomarkers: unknown }) {
  return sb.rpc('health_ingest_lab_report', payload);
}

export async function rpcHealthIngestWearableSamples(sb: SupabaseClient, payload: { p_provider: unknown; p_samples: unknown }) {
  return sb.rpc('health_ingest_wearable_samples', payload);
}

export async function rpcHealthComputeFeaturesDaily(sb: SupabaseClient, date: string) {
  return sb.rpc('health_compute_features_daily', { p_date: date });
}

export async function rpcHealthComputeVitanaIndex(sb: SupabaseClient, date: string, modelVersion: unknown) {
  return sb.rpc('health_compute_vitana_index', { p_date: date, p_model_version: modelVersion });
}

export async function rpcHealthGenerateRecommendations(sb: SupabaseClient, from: string, to: string, modelVersion: unknown) {
  return sb.rpc('health_generate_recommendations', { p_from: from, p_to: to, p_model_version: modelVersion });
}

// ==================== vitana_index_scores ====================

export async function fetchVitanaIndexScoreForDate(sb: SupabaseClient, date: string) {
  return sb.from('vitana_index_scores').select('*').eq('date', date).single();
}

export async function upsertVitanaIndexScore(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('vitana_index_scores').upsert(row, { onConflict: 'tenant_id,user_id,date' });
}

export async function fetchVitanaIndexScoreExistsForUser(sb: SupabaseClient, userId: string) {
  return sb.from('vitana_index_scores').select('id').eq('user_id', userId).limit(1).maybeSingle();
}

// ==================== recommendations ====================

export async function fetchRecommendationsForDate(sb: SupabaseClient, date: string) {
  return sb.from('recommendations').select('*').eq('date', date).order('priority', { ascending: false });
}

// ==================== user_tenants ====================

export async function fetchTenantIdForUser(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).limit(1).maybeSingle();
}

// ==================== vitana_index_baseline_survey ====================

export async function upsertBaselineSurvey(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('vitana_index_baseline_survey').upsert(row, { onConflict: 'user_id' });
}

export async function fetchBaselineSurveyCompletedAt(sb: SupabaseClient) {
  return sb.from('vitana_index_baseline_survey').select('completed_at').maybeSingle();
}

// ==================== vitana_index_config ====================

export async function fetchActivePillarWeightsConfig(sb: SupabaseClient) {
  return sb
    .from('vitana_index_config')
    .select('pillar_weights')
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
}
