/**
 * interaction-style/interaction-style-fetcher.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The Supabase `.from(...)` call in interaction-style-fetcher.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same query, same columns, same filters, same return shape — no behavior
 * change today. Client-agnostic (takes `supabase` as a param), same
 * convention as every other *-repository.ts in this codebase.
 *
 * B6 wall note (unchanged from the source file): this stays READ-ONLY —
 * no insert/update/upsert/delete/rpc.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_assistant_state ====================

export async function fetchInteractionStyleSignalRow(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  signalName: string,
) {
  return supabase
    .from('user_assistant_state')
    .select('value, confidence, updated_at, last_seen_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('signal_name', signalName)
    .maybeSingle();
}
