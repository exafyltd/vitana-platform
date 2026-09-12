/**
 * orb-tools/diary-memory-tools.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools/diary-memory-tools.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param) — tools receive their client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== diary_entries ====================

export async function fetchDiaryEntriesInWindow(sb: SupabaseClient, userId: string, fromIso: string | undefined, toIso: string | undefined, limit: number) {
  let q = sb.from('diary_entries').select('id, text, source, tags, created_at').eq('user_id', userId);
  if (fromIso) q = q.gte('created_at', fromIso);
  if (toIso) q = q.lte('created_at', toIso);
  return q.order('created_at', { ascending: false }).limit(limit);
}

export async function fetchAllDiaryEntryTimestamps(sb: SupabaseClient, userId: string, limit: number) {
  return sb.from('diary_entries').select('created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
}

export async function fetchDiaryEntriesForTimeline(sb: SupabaseClient, userId: string, fromIso: string | undefined, toIso: string | undefined, limit: number) {
  let q = sb.from('diary_entries').select('id, text, created_at').eq('user_id', userId);
  if (fromIso) q = q.gte('created_at', fromIso);
  if (toIso) q = q.lte('created_at', toIso);
  return q.order('created_at', { ascending: false }).limit(limit);
}

// ==================== memory_items ====================

export async function fetchMemoryItemsForTimeline(sb: SupabaseClient, tenantId: string | null, userId: string, fromIso: string | undefined, toIso: string | undefined, limit: number) {
  let q = sb.from('memory_items').select('id, category_key, source, content, occurred_at').eq('tenant_id', tenantId).eq('user_id', userId);
  if (fromIso) q = q.gte('occurred_at', fromIso);
  if (toIso) q = q.lte('occurred_at', toIso);
  return q.order('occurred_at', { ascending: false }).limit(limit);
}

export async function searchMemoryItemsByContent(sb: SupabaseClient, tenantId: string | null, userId: string, pattern: string, categoryKeys: string[] | undefined, limit: number) {
  let q = sb.from('memory_items').select('id, category_key, content, occurred_at').eq('tenant_id', tenantId).eq('user_id', userId).ilike('content', pattern);
  if (categoryKeys) q = q.in('category_key', categoryKeys);
  return q.order('occurred_at', { ascending: false }).limit(limit);
}

export async function fetchUserMemoryCategoryKeys(sb: SupabaseClient, tenantId: string | null, userId: string, limit: number) {
  return sb.from('memory_items').select('category_key').eq('tenant_id', tenantId).eq('user_id', userId).limit(limit);
}

export async function fetchMemoryItemForForget(sb: SupabaseClient, memoryId: string, tenantId: string | null, userId: string) {
  return sb.from('memory_items').select('id, category_key, content, occurred_at').eq('id', memoryId).eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle();
}

export async function deleteMemoryItem(sb: SupabaseClient, memoryId: string, tenantId: string | null, userId: string) {
  return sb.from('memory_items').delete().eq('id', memoryId).eq('tenant_id', tenantId).eq('user_id', userId);
}

// ==================== memory_facts ====================

export async function fetchActiveMemoryFactsForTimeline(sb: SupabaseClient, tenantId: string | null, userId: string, fromIso: string | undefined, toIso: string | undefined, limit: number) {
  let q = sb.from('memory_facts').select('id, fact_key, fact_value, extracted_at').eq('tenant_id', tenantId).eq('user_id', userId).is('superseded_by', null);
  if (fromIso) q = q.gte('extracted_at', fromIso);
  if (toIso) q = q.lte('extracted_at', toIso);
  return q.order('extracted_at', { ascending: false }).limit(limit);
}

export async function searchActiveMemoryFactsByValue(sb: SupabaseClient, tenantId: string | null, userId: string, pattern: string, limit: number) {
  return sb
    .from('memory_facts')
    .select('id, fact_key, fact_value, extracted_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .is('superseded_by', null)
    .ilike('fact_value', pattern)
    .limit(limit);
}

export async function searchActiveMemoryFactsByKey(sb: SupabaseClient, tenantId: string | null, userId: string, pattern: string, limit: number) {
  return sb
    .from('memory_facts')
    .select('id, fact_key, fact_value, extracted_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .is('superseded_by', null)
    .ilike('fact_key', pattern)
    .limit(limit);
}

// ==================== memory_category_mapping ====================

export async function fetchMemoryCategoryMapping(sb: SupabaseClient) {
  return sb.from('memory_category_mapping').select('source_category, garden_category');
}

// ==================== memory_garden_config ====================

export async function fetchMemoryGardenConfig(sb: SupabaseClient) {
  return sb.from('memory_garden_config').select('category_key, label, display_order').order('display_order', { ascending: true });
}

// ==================== memory_deletions ====================

export async function insertMemoryDeletion(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('memory_deletions').insert(row);
}
