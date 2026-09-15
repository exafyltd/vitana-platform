/**
 * guide/initiative-registry.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/initiative-registry.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filters/ordering, same
 * return shapes — no behavior change today. Client-agnostic (takes
 * `supabase` as a param), same convention as every other *-repository.ts
 * in this codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== autopilot_recommendations ====================

export async function fetchTopOpenAutopilotRecommendation(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('autopilot_recommendations')
    .select('id, title, summary, priority')
    .eq('user_id', userId)
    .in('status', ['new', 'pending'])
    .order('priority', { ascending: false })
    .limit(1);
}

// ==================== relationship_nodes ====================

export async function fetchMostDormantConnectionNode(supabase: SupabaseClient, ownerUserId: string) {
  return supabase
    .from('relationship_nodes')
    .select('id, display_name, metadata')
    .eq('owner_user_id', ownerUserId)
    .eq('node_type', 'person')
    .order('updated_at', { ascending: true })
    .limit(1);
}
