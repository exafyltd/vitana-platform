/**
 * capability-awareness/supabase-capability-fetcher.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in supabase-capability-fetcher.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filters, same return shapes —
 * no behavior change today. Client-agnostic (takes `supabase` as a param),
 * same convention as every other *-repository.ts in this codebase.
 *
 * Wall discipline note (unchanged from the source file): this stays
 * READ-ONLY — no insert/update/upsert/delete/rpc.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== system_capabilities ====================

export async function fetchEnabledCapabilities(supabase: SupabaseClient) {
  return supabase
    .from('system_capabilities')
    .select(
      'capability_key, display_name, description, required_role, required_tenant_features, required_integrations, helpful_for_intents, enabled',
    )
    .eq('enabled', true);
}

// ==================== user_capability_awareness ====================

export async function fetchUserCapabilityAwareness(supabase: SupabaseClient, tenantId: string, userId: string) {
  return supabase
    .from('user_capability_awareness')
    .select(
      'capability_key, awareness_state, first_introduced_at, last_introduced_at, first_used_at, last_used_at, use_count, dismiss_count, mastery_confidence, last_surface',
    )
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);
}
