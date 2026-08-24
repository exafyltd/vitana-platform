/**
 * routes/orb-livekit.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/orb-livekit.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return shapes —
 * no behavior change today. Client-agnostic (takes `sb` as a param) — the
 * route receives its client per-call, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== bootstrap_cache ====================

export async function fetchBootstrapCacheEntry(sb: SupabaseClient, cacheKey: string, nowIso: string) {
  return sb
    .from('bootstrap_cache')
    .select('payload, expires_at')
    .eq('cache_key', cacheKey)
    .gt('expires_at', nowIso)
    .maybeSingle();
}

export async function upsertBootstrapCache(sb: SupabaseClient, cacheKey: string, payload: Record<string, unknown>, expiresAtIso: string) {
  return sb
    .from('bootstrap_cache')
    .upsert({ cache_key: cacheKey, payload, expires_at: expiresAtIso }, { onConflict: 'cache_key' });
}

// ==================== system_config (voice.active_provider) ====================

export async function fetchActiveProviderConfig(sb: SupabaseClient, key: string) {
  return sb.from('system_config').select('value, updated_by, updated_at').eq('key', key).maybeSingle();
}

export async function upsertActiveProviderConfig(sb: SupabaseClient, key: string, value: unknown, changedBy: string | null) {
  return sb.from('system_config').upsert(
    { key, value: value as unknown as object, updated_by: changedBy ?? 'system' },
    { onConflict: 'key' },
  );
}

// ==================== voice_active_provider_changes ====================

export async function insertVoiceActiveProviderChange(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('voice_active_provider_changes').insert(row);
}

// ==================== orb_session_state ====================

export async function fetchOrbSessionStateContinuity(sb: SupabaseClient) {
  return sb.from('orb_session_state').select('user_id, key, value, expires_at, updated_at').eq('key', 'continuity');
}

// ==================== agent_voice_configs ====================

export async function fetchAgentVoiceConfig(sb: SupabaseClient, agentId: string) {
  return sb.from('agent_voice_configs').select('*').eq('agent_id', agentId).maybeSingle();
}

export async function upsertAgentVoiceConfig(sb: SupabaseClient, update: Record<string, unknown>) {
  return sb.from('agent_voice_configs').upsert(update, { onConflict: 'agent_id' }).select('*').single();
}

// ==================== app_users ====================

export async function fetchAppUserDisplayName(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('display_name').eq('user_id', userId).maybeSingle();
}

export async function fetchAppUserProfile(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('display_name, registration_seq').eq('user_id', userId).maybeSingle();
}

// ==================== memory_facts ====================

export async function fetchUserNameFact(sb: SupabaseClient, userId: string) {
  return sb
    .from('memory_facts')
    .select('fact_value')
    .eq('user_id', userId)
    .eq('fact_key', 'user_name')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchIdentityCoreFacts(sb: SupabaseClient, userId: string, keys: string[]) {
  return sb
    .from('memory_facts')
    .select('fact_key, fact_value, entity')
    .eq('user_id', userId)
    .in('fact_key', keys)
    .is('superseded_by', null)
    .order('provenance_confidence', { ascending: false })
    .limit(40);
}

// ==================== memory_items ====================

export async function fetchRecentMemoryItems(sb: SupabaseClient, userId: string, limit: number) {
  return sb.from('memory_items').select('id, content').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
}

// ==================== vitana_index_scores ====================

export async function fetchLatestVitanaIndexScoreDetailed(sb: SupabaseClient, userId: string) {
  return sb
    .from('vitana_index_scores')
    .select('date, score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
}

// ==================== life_compass ====================

export async function fetchActiveLifeCompass(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('id, primary_goal, category, is_active, created_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

// ==================== agent_personas ====================

export async function fetchAgentPersonaPrompt(sb: SupabaseClient, key: string) {
  return sb.from('agent_personas').select('system_prompt, display_name').eq('key', key).maybeSingle();
}

// ==================== voice_providers ====================

export async function fetchEnabledVoiceProviders(sb: SupabaseClient) {
  return sb
    .from('voice_providers')
    .select('id, kind, display_name, models, options_schema, plugin_module, fallback_chain, enabled, notes')
    .eq('enabled', true)
    .order('kind', { ascending: true })
    .order('id', { ascending: true });
}

export async function fetchVoiceProvidersByIds(sb: SupabaseClient, ids: string[]) {
  return sb.from('voice_providers').select('id, enabled').in('id', ids);
}
