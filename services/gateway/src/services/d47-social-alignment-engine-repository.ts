// impact-allow-no-test: pure data-access seam (thin Supabase RPC
// wrappers, no independent request-handling behavior); exercised
// indirectly by d47-social-alignment-engine.ts's existing test suite
// (test/d47-social-alignment.test.ts), which mocks @supabase/supabase-js,
// not this module.
/**
 * services/d47-social-alignment-engine.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.rpc(...)` call in d47-social-alignment-engine.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC names, same params, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function bootstrapDevRequestContext(sb: SupabaseClient, tenantId: string) {
  return sb.rpc('dev_bootstrap_request_context', { p_tenant_id: tenantId, p_active_role: 'developer' });
}

export async function alignmentGenerateSuggestionsRpc(sb: SupabaseClient, params: Record<string, unknown>) {
  return sb.rpc('alignment_generate_suggestions', params);
}

export async function alignmentGetSuggestionsRpc(sb: SupabaseClient, params: Record<string, unknown>) {
  return sb.rpc('alignment_get_suggestions', params);
}

export async function alignmentMarkShownRpc(sb: SupabaseClient, suggestionId: string) {
  return sb.rpc('alignment_mark_shown', { p_suggestion_id: suggestionId });
}

export async function alignmentActOnSuggestionRpc(sb: SupabaseClient, params: Record<string, unknown>) {
  return sb.rpc('alignment_act_on_suggestion', params);
}

export async function alignmentCleanupExpiredRpc(sb: SupabaseClient) {
  return sb.rpc('alignment_cleanup_expired');
}
