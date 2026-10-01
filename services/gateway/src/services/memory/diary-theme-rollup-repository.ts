// impact-allow-no-test: pure data-access seam (thin Supabase query/upsert
// wrappers). Exercised through test/services/memory/diary-theme-rollup.test.ts
// against a fake Supabase stub, not mocked away.
/**
 * VTID-04444 (Conversation rebuild WS-4.2) — data access for the nightly
 * diary theme rollup. Client-agnostic (takes `sb` as a param), same seam
 * shape as nightly-consolidator-repository.ts.
 *
 * Reads `diary_entries` — the live diary (text, created_at, per user). The
 * consolidator's older count reads `memory_diary_entries`, which holds one
 * row in production; see docs/validation/VTID-04444/acceptance.md.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Users with diary entries since `sinceIso` — one row per entry, bounded. */
export async function fetchDiaryAuthorsSince(sb: SupabaseClient, sinceIso: string, limit: number) {
  return sb
    .from('diary_entries')
    .select('user_id')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function fetchUserDiaryEntriesSince(sb: SupabaseClient, userId: string, sinceIso: string, limit: number) {
  return sb
    .from('diary_entries')
    .select('text, created_at')
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit);
}

/** Primary tenant for each of `userIds` (diary_entries carries no tenant). */
export async function fetchPrimaryTenants(sb: SupabaseClient, userIds: string[]) {
  return sb
    .from('user_tenants')
    .select('user_id, tenant_id')
    .in('user_id', userIds)
    .eq('is_primary', true);
}

export async function fetchAssistantState(sb: SupabaseClient, tenantId: string, userId: string, signalName: string) {
  return sb
    .from('user_assistant_state')
    .select('value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('signal_name', signalName)
    .maybeSingle();
}

export async function upsertAssistantState(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('user_assistant_state').upsert(row, { onConflict: 'tenant_id,user_id,signal_name' });
}
