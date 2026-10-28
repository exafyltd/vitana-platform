// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/specialists-connections.ts — zero
// coverage today.
/**
 * routes/specialists-connections.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Reused by both GET and POST /personas/:key/connections. */
export async function fetchPersonaIdByKey(sb: SupabaseClient, key: string) {
  return sb.from('agent_personas').select('id').eq('key', key).maybeSingle();
}

export async function fetchPersonaConnections(sb: SupabaseClient, personaId: string) {
  return sb.from('agent_third_party_connections').select('id, provider, status, last_check_at, created_at').eq('persona_id', personaId);
}

export async function insertConnection(sb: SupabaseClient, row: { persona_id: string; provider: string; status: string; created_by: string }) {
  return sb.from('agent_third_party_connections').insert(row).select('*').single();
}

/** Reused by the connection-add and connection-remove audit writes. */
export function insertAuditLog(sb: SupabaseClient, row: Record<string, unknown>): PromiseLike<{ error: unknown }> {
  return sb.from('agent_audit_log').insert(row);
}

/** Reused by the DELETE and /test routes' existence checks. */
export async function fetchConnectionById(sb: SupabaseClient, id: string) {
  return sb.from('agent_third_party_connections').select('*').eq('id', id).maybeSingle();
}

export async function deleteConnection(sb: SupabaseClient, id: string) {
  return sb.from('agent_third_party_connections').delete().eq('id', id);
}

export function updateConnectionStatus(sb: SupabaseClient, id: string, status: string, lastCheckAt: string): PromiseLike<{ error: unknown }> {
  return sb.from('agent_third_party_connections').update({ status, last_check_at: lastCheckAt }).eq('id', id);
}
