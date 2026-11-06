/**
 * orb-memory-bridge.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in orb-memory-bridge.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param) — the bridge receives its client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== memory_items ====================

export async function fetchOrbConversationItems(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  sources: string[],
  startIso: string,
  endIso: string,
) {
  return sb
    .from('memory_items')
    .select('content, content_json, occurred_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .in('source', sources)
    .gte('occurred_at', startIso)
    .lte('occurred_at', endIso)
    .order('occurred_at', { ascending: true })
    .limit(100);
}

export async function fetchRecentOrbUserTurnsRaw(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  sources: string[],
  fetchLimit: number,
) {
  return sb
    .from('memory_items')
    .select('content, content_json, occurred_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .in('source', sources)
    .order('occurred_at', { ascending: false })
    .limit(fetchLimit);
}

export async function insertMemoryItem(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('memory_items').insert(row).select('id, category_key').single();
}

/** Persistent (no time filter), ordered by importance — sequential dev-bootstrap variant. */
export async function fetchPersistentMemoryItemsByImportance(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  categories: string[],
  limit: number,
) {
  return sb
    .from('memory_items')
    .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .in('category_key', categories)
    .order('importance', { ascending: false })
    .limit(limit);
}

/** Time-sensitive, ordered by importance — sequential dev-bootstrap variant. */
export async function fetchTimeSensitiveMemoryItemsByImportance(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  categories: string[],
  sinceIso: string,
  limit: number,
) {
  return sb
    .from('memory_items')
    .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .in('category_key', categories)
    .gte('occurred_at', sinceIso)
    .order('importance', { ascending: false })
    .limit(limit);
}

/** Time-sensitive, ordered by occurred_at — "scored" dev-bootstrap variant. */
export async function fetchTimeSensitiveMemoryItemsByOccurredAt(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  categories: string[],
  sinceIso: string,
  limit: number,
) {
  return sb
    .from('memory_items')
    .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .in('category_key', categories)
    .gte('occurred_at', sinceIso)
    .order('occurred_at', { ascending: false })
    .limit(limit);
}

// ==================== memory_diary_entries / diary_entries / ai_memory ====================

export async function rpcDevBootstrapRequestContextByTenantId(
  sb: SupabaseClient,
  tenantId: string,
  activeRole: string,
) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}

export async function rpcDevBootstrapRequestContextByTenantSlug(
  sb: SupabaseClient,
  tenantSlug: string,
  userId: string,
  activeRole: string,
) {
  return sb.rpc('dev_bootstrap_request_context', {
    p_tenant_slug: tenantSlug,
    p_user_id: userId,
    p_active_role: activeRole,
  });
}

export async function rpcGetTrustScores(sb: SupabaseClient) {
  return sb.rpc('get_trust_scores');
}

export async function rpcGetBehaviorConstraints(sb: SupabaseClient, constraintType: string | null) {
  return sb.rpc('get_behavior_constraints', { p_constraint_type: constraintType });
}

export async function rpcGetCorrectionHistory(
  sb: SupabaseClient,
  limit: number,
  offset: number,
  feedbackType: string | null,
) {
  return sb.rpc('get_correction_history', { p_limit: limit, p_offset: offset, p_feedback_type: feedbackType });
}
