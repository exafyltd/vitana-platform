/**
 * consent-gate.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in consent-gate.ts now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same queries,
 * same columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `supabase` as a param),
 * same convention as every other *-repository.ts in this directory.
 *
 * This is the outbound-action consent/execution ledger (VTID-02300) — a
 * governance-adjacent file — so extra care was taken to preserve every
 * state-transition update's exact patch shape and filter.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_action_permissions ====================

export async function fetchBlanketGrant(supabase: SupabaseClient, userId: string, actionType: string) {
  return supabase
    .from('user_action_permissions')
    .select('granted')
    .eq('user_id', userId)
    .eq('action_type', actionType)
    .eq('granted', true)
    .maybeSingle();
}

// ==================== pending_connector_actions ====================

export async function insertPendingAction(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase
    .from('pending_connector_actions')
    .insert(row)
    .select('id, state, action_type, preview_title, preview_description, preview_data, requested_by, requested_at, expires_at, connector_id, product_id')
    .single();
}

export async function fetchPendingActionForApproval(supabase: SupabaseClient, actionId: string, userId: string) {
  return supabase
    .from('pending_connector_actions')
    .select('id, user_id, tenant_id, state, expires_at, action_type, args')
    .eq('id', actionId)
    .eq('user_id', userId)
    .single();
}

export async function markActionExpired(supabase: SupabaseClient, actionId: string) {
  return supabase.from('pending_connector_actions').update({ state: 'expired' }).eq('id', actionId);
}

export async function markActionApproved(supabase: SupabaseClient, actionId: string, approvedAtIso: string) {
  return supabase.from('pending_connector_actions').update({ state: 'approved', approved_at: approvedAtIso }).eq('id', actionId);
}

export async function markActionDenied(supabase: SupabaseClient, actionId: string, userId: string, deniedAtIso: string) {
  return supabase
    .from('pending_connector_actions')
    .update({ state: 'denied', denied_at: deniedAtIso })
    .eq('id', actionId)
    .eq('user_id', userId);
}

export async function fetchActionForAudit(supabase: SupabaseClient, actionId: string) {
  return supabase
    .from('pending_connector_actions')
    .select('tenant_id, action_type, capability, args, preview_title, requested_by, requested_at, vtid, recommendation_id, product_id')
    .eq('id', actionId)
    .single();
}

export async function fetchUserPendingActionsList(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase
    .from('pending_connector_actions')
    .select('id, state, action_type, preview_title, preview_description, preview_data, requested_by, requested_at, expires_at, connector_id, product_id')
    .eq('user_id', userId)
    .eq('state', 'pending')
    .order('requested_at', { ascending: false })
    .limit(limit);
}

export async function fetchFullPendingAction(supabase: SupabaseClient, actionId: string) {
  return supabase.from('pending_connector_actions').select('*').eq('id', actionId).single();
}

export async function markActionExecuting(supabase: SupabaseClient, actionId: string) {
  return supabase.from('pending_connector_actions').update({ state: 'executing' }).eq('id', actionId);
}

export async function markActionFailed(supabase: SupabaseClient, actionId: string, patch: { error: string; failed_at: string }) {
  return supabase.from('pending_connector_actions').update({ state: 'failed', ...patch }).eq('id', actionId);
}

export async function markActionExecuted(supabase: SupabaseClient, actionId: string, patch: Record<string, unknown>) {
  return supabase.from('pending_connector_actions').update({ state: 'executed', ...patch }).eq('id', actionId);
}

export async function bulkExpirePendingActions(supabase: SupabaseClient, nowIso: string) {
  return supabase
    .from('pending_connector_actions')
    .update({ state: 'expired' })
    .eq('state', 'pending')
    .lt('expires_at', nowIso)
    .select('id');
}

// ==================== action_ledger ====================

export async function insertActionLedgerEntry(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('action_ledger').insert(row);
}
