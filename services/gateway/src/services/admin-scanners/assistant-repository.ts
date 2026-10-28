// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/assistant.ts — zero coverage
// today.
/**
 * services/admin-scanners/assistant.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * admin-scanners/assistant.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countTenantAssistantConfigRows(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_assistant_config').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
}

export async function fetchStaleAssistantOverrides(sb: SupabaseClient, tenantId: string, beforeIso: string) {
  return sb
    .from('tenant_assistant_config')
    .select('surface_key, updated_at, system_prompt_override')
    .eq('tenant_id', tenantId)
    .not('system_prompt_override', 'is', null)
    .lt('updated_at', beforeIso);
}

export async function countOrbStallEventsSinceForAssistant(sb: SupabaseClient, sinceIso: string) {
  return sb.from('oasis_events').select('id', { count: 'exact', head: true }).eq('topic', 'orb.live.stall_detected').gte('occurred_at', sinceIso);
}

export async function countVoiceSessionStartsSince(sb: SupabaseClient, sinceIso: string) {
  return sb
    .from('oasis_events')
    .select('id', { count: 'exact', head: true })
    .in('topic', ['vtid.live.session.start', 'voice.live.session.start'])
    .gte('occurred_at', sinceIso);
}
