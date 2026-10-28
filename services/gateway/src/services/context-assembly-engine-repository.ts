// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references context-assembly-engine.ts — zero coverage
// today.
/**
 * services/context-assembly-engine.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * context-assembly-engine.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchPersistentMemoryItems(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  persistentCategories: readonly string[],
  limit: number,
) {
  return sb
    .from('memory_items')
    .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .in('category_key', persistentCategories)
    .order('importance', { ascending: false })
    .order('occurred_at', { ascending: false })
    .limit(limit);
}

export async function fetchTimeSensitiveMemoryItems(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  persistentCategories: readonly string[],
  sinceIso: string,
  limit: number,
) {
  return sb
    .from('memory_items')
    .select('id, category_key, source, content, content_json, importance, occurred_at, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .not('category_key', 'in', `(${persistentCategories.join(',')})`)
    .gte('occurred_at', sinceIso)
    .order('importance', { ascending: false })
    .order('occurred_at', { ascending: false })
    .limit(limit);
}

export async function fetchDiaryEntriesSince(sb: SupabaseClient, tenantId: string, userId: string, sinceDate: string, limit: number) {
  return sb
    .from('memory_diary_entries')
    .select('id, entry_date, entry_type, raw_text, mood, energy_level, tags, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .gte('entry_date', sinceDate)
    .order('entry_date', { ascending: false })
    .limit(limit);
}

export async function fetchGardenNodes(sb: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return sb
    .from('memory_garden_nodes')
    .select('id, domain, node_type, title, summary, confidence, first_seen, last_seen')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('confidence', { ascending: false })
    .order('last_seen', { ascending: false })
    .limit(limit);
}

export async function devBootstrapRequestContext(sb: SupabaseClient, tenantId: string, activeRole: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: activeRole });
}
