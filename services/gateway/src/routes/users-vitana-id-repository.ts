// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/users-vitana-id.ts — zero coverage
// today.
/**
 * routes/users-vitana-id.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchProfileForSuggestion(sb: SupabaseClient, userId: string) {
  return sb.from('profiles').select('display_name, full_name, email, vitana_id, vitana_id_locked, registration_seq').eq('user_id', userId).maybeSingle();
}

export async function fetchProfileForConfirm(sb: SupabaseClient, userId: string) {
  return sb.from('profiles').select('vitana_id, vitana_id_locked, registration_seq').eq('user_id', userId).maybeSingle();
}

export async function fetchReservedToken(sb: SupabaseClient, base: string) {
  return sb.from('vitana_id_reserved').select('token').eq('token', base).maybeSingle();
}

export async function fetchVitanaIdOwner(sb: SupabaseClient, requested: string, excludeUserId: string) {
  return sb.from('profiles').select('user_id').eq('vitana_id', requested).neq('user_id', excludeUserId).maybeSingle();
}

export async function fetchHandleAliasOwner(sb: SupabaseClient, requested: string, excludeUserId: string) {
  return sb.from('handle_aliases').select('user_id').eq('old_handle', requested).neq('user_id', excludeUserId).maybeSingle();
}

export function upsertHandleAlias(sb: SupabaseClient, oldHandle: string, userId: string): PromiseLike<{ error: unknown }> {
  return sb.from('handle_aliases').upsert({ old_handle: oldHandle, user_id: userId }, { onConflict: 'old_handle' });
}

export async function confirmVitanaId(sb: SupabaseClient, userId: string, vitanaId: string) {
  return sb.from('profiles').update({ vitana_id: vitanaId, handle: vitanaId, vitana_id_locked: true }).eq('user_id', userId);
}
