// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/voice-teach-inspector.ts — zero coverage
// today.
/**
 * routes/voice-teach-inspector.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in voice-teach-inspector.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAllSystemCapabilitiesOrdered(sb: SupabaseClient) {
  return sb
    .from('system_capabilities')
    .select(
      'capability_key, display_name, description, manual_path, required_role, required_integrations, helpful_for_intents, enabled, surfaced_at, updated_at',
    )
    .order('capability_key', { ascending: true });
}

export async function fetchUserCapabilityAwarenessLedger(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_capability_awareness')
    .select(
      'capability_key, awareness_state, first_introduced_at, last_introduced_at, first_used_at, last_used_at, use_count, dismiss_count, mastery_confidence, last_surface, updated_at',
    )
    .eq('user_id', userId);
}
