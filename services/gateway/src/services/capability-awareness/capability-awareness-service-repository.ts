/**
 * capability-awareness/capability-awareness-service.ts — Aurora migration
 * B1 data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The Supabase `.rpc(...)` call in capability-awareness-service.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same RPC name, same params, same return shape — no behavior
 * change today. Client-agnostic (takes `supabase` as a param), same
 * convention as every other *-repository.ts in this codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface AdvanceCapabilityAwarenessParams {
  p_tenant_id: string;
  p_user_id: string;
  p_capability_key?: string | null;
  p_event_name: string;
  p_idempotency_key: string;
  p_decision_id?: string | null;
  p_source_surface?: string | null;
  p_occurred_at?: string | null;
  p_metadata?: unknown;
}

// ==================== advance_capability_awareness RPC ====================

export async function advanceCapabilityAwareness(
  supabase: SupabaseClient,
  params: AdvanceCapabilityAwarenessParams,
) {
  return supabase.rpc('advance_capability_awareness', params);
}
