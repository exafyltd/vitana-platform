// impact-allow-no-test: pure data-access seam (thin Supabase RPC wrappers, no
// independent request-handling behavior); exercised indirectly by
// routes/memory-governance.ts's existing test suite
// (test/routes/memory-governance.test.ts), which covers every call site
// here.
/**
 * routes/memory-governance.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in routes/memory-governance.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same RPC names, same params, same return shapes — no behavior change
 * today. Client-agnostic (takes `sb` as a param) — the route builds a
 * fresh user-scoped client per request via createUserSupabaseClient(token).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function getMemorySettings(sb: SupabaseClient) {
  return sb.rpc('memory_get_settings');
}

export async function setMemoryVisibility(sb: SupabaseClient, params: { p_domain: string; p_visibility: string; p_custom_rules: unknown }) {
  return sb.rpc('memory_set_visibility', params);
}

export async function lockMemoryEntity(sb: SupabaseClient, params: { p_entity_type: string; p_entity_id: string; p_reason: string | null }) {
  return sb.rpc('memory_lock_entity', params);
}

export async function unlockMemoryEntity(sb: SupabaseClient, params: { p_entity_type: string; p_entity_id: string }) {
  return sb.rpc('memory_unlock_entity', params);
}

export async function deleteMemoryEntity(sb: SupabaseClient, params: { p_entity_type: string; p_entity_id: string }) {
  return sb.rpc('memory_delete_entity', params);
}

export async function getLockedMemoryEntities(sb: SupabaseClient, params: { p_entity_type: string | null }) {
  return sb.rpc('memory_get_locked_entities', params);
}

export async function requestMemoryExport(sb: SupabaseClient, params: { p_domains: string[]; p_format: string }) {
  return sb.rpc('memory_request_export', params);
}

export async function getMemoryExportStatus(sb: SupabaseClient, params: { p_export_id: string }) {
  return sb.rpc('memory_get_export_status', params);
}
