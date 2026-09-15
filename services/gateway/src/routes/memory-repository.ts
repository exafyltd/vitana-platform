// impact-allow-no-test: pure data-access seam (thin Supabase RPC/query
// wrappers, no independent request-handling behavior); exercised
// indirectly by routes/memory.ts's existing test suites
// (test/memory.test.ts, test/memory-confidence.test.ts), which mock the
// Supabase client factory, not this module.
/**
 * routes/memory.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in this file now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC names, same params, same queries, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function writeMemoryItemRpc(
  sb: SupabaseClient,
  params: { p_category_key: string; p_source: unknown; p_content: unknown; p_content_json: unknown; p_importance: unknown; p_occurred_at: unknown },
) {
  return sb.rpc('memory_write_item', params);
}

export async function getMemoryContextRpc(sb: SupabaseClient, params: { p_limit: unknown; p_categories: unknown; p_since: unknown }) {
  return sb.rpc('memory_get_context', params);
}

export async function memoryRetrieveRpc(sb: SupabaseClient, params: { p_payload: unknown }) {
  return sb.rpc('memory_retrieve', params);
}

export async function getMemoryGardenProgressRpc(sb: SupabaseClient) {
  return sb.rpc('memory_get_garden_progress');
}

export async function getMeContextRpc(sb: SupabaseClient) {
  return sb.rpc('me_context');
}

export async function getMemoryTimelineRpc(sb: SupabaseClient, params: { p_user_id: string; p_from: unknown; p_to: unknown }) {
  return sb.rpc('memory_get_timeline', params);
}

export async function buildMemoryTimelineRpc(sb: SupabaseClient, params: { p_user_id: string; p_from: unknown; p_to: unknown }) {
  return sb.rpc('memory_build_timeline', params);
}

export async function addMemoryDiaryEntryRpc(
  sb: SupabaseClient,
  params: { p_entry_date: unknown; p_entry_type: unknown; p_raw_text: unknown; p_mood: unknown; p_energy_level: unknown; p_tags: unknown },
) {
  return sb.rpc('memory_add_diary_entry', params);
}

/** Shared by both the diary-write hook and the diary-read reconcile path. */
export async function recomputeVitanaIndexForUser(sb: SupabaseClient, userId: string, date: unknown) {
  return sb.rpc('health_compute_vitana_index_for_user', { p_user_id: userId, p_date: date });
}

export async function fetchUserTenantId(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).limit(1).maybeSingle();
}

export async function fetchVitanaIndexScoreRow(sb: SupabaseClient, userId: string, date: unknown) {
  return sb
    .from('vitana_index_scores')
    .select('score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental')
    .eq('user_id', userId)
    .eq('date', date)
    .maybeSingle();
}

export async function getMemoryDiaryEntriesRpc(sb: SupabaseClient, params: { p_from: unknown; p_to: unknown; p_limit: unknown }) {
  return sb.rpc('memory_get_diary_entries', params);
}

export async function extractMemoryGardenNodesRpc(sb: SupabaseClient, params: { p_diary_entry_id: unknown }) {
  return sb.rpc('memory_extract_garden_nodes', params);
}

export async function getMemoryGardenSummaryRpc(sb: SupabaseClient) {
  return sb.rpc('memory_get_garden_summary');
}

export async function computeMemoryQualityRpc(sb: SupabaseClient, params: { p_user_id: unknown; p_date: unknown }) {
  return sb.rpc('memory_compute_quality', params);
}

export async function getMemoryQualityRpc(sb: SupabaseClient, params: { p_user_id: unknown }) {
  return sb.rpc('memory_get_quality', params);
}

export async function adjustMemoryConfidenceRpc(sb: SupabaseClient, params: { p_memory_item_id: unknown; p_reason_code: unknown; p_context: unknown }) {
  return sb.rpc('memory_adjust_confidence', params);
}

export async function confirmMemoryItemRpc(sb: SupabaseClient, params: { p_memory_item_id: unknown; p_confirmation_notes: unknown }) {
  return sb.rpc('memory_confirm_item', params);
}

export async function correctMemoryItemRpc(sb: SupabaseClient, params: { p_memory_item_id: unknown; p_correction_notes: unknown; p_new_content: unknown }) {
  return sb.rpc('memory_correct_item', params);
}

export async function getMemoryConfidenceHistoryRpc(sb: SupabaseClient, params: { p_memory_item_id: unknown; p_limit: unknown }) {
  return sb.rpc('memory_get_confidence_history', params);
}

export async function getMemoryContextWithConfidenceRpc(
  sb: SupabaseClient,
  params: { p_limit: unknown; p_min_confidence: unknown; p_categories: unknown; p_since: unknown; p_include_low_confidence: unknown },
) {
  return sb.rpc('memory_get_context_with_confidence', params);
}

export async function applyMemoryTimeDecayRpc(sb: SupabaseClient, params: { p_decay_threshold_days: unknown }) {
  return sb.rpc('memory_apply_time_decay', params);
}

export async function fetchMemorySourceTrust(sb: SupabaseClient) {
  return sb.from('memory_source_trust').select('*').order('trust_weight', { ascending: false });
}

export async function fetchMemoryConfidenceReasons(sb: SupabaseClient) {
  return sb.from('memory_confidence_reasons').select('*').order('category', { ascending: true }).order('delta_max', { ascending: false });
}
