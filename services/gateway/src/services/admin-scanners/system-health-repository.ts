// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/system-health.ts — zero
// coverage today.
/**
 * services/admin-scanners/system-health.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * admin-scanners/system-health.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countOrbStallEventsSince(sb: SupabaseClient, sinceIso: string) {
  return sb.from('oasis_events').select('id', { count: 'exact', head: true }).eq('topic', 'orb.live.stall_detected').gte('created_at', sinceIso);
}

export async function countErrorEventsSince(sb: SupabaseClient, sinceIso: string) {
  return sb.from('oasis_events').select('id', { count: 'exact', head: true }).eq('status', 'error').gte('created_at', sinceIso);
}

export async function fetchRecentDeployFailures(sb: SupabaseClient, sinceIso: string) {
  return sb
    .from('oasis_events')
    .select('topic, created_at, message')
    .in('topic', ['cicd.deploy.failed', 'deploy.gateway.failed'])
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(5);
}

export async function fetchServiceTierAgents(sb: SupabaseClient) {
  return sb
    .from('agents_registry')
    .select('agent_id, name, tier, last_heartbeat_at')
    .eq('tier', 'service')
    .order('last_heartbeat_at', { ascending: true, nullsFirst: true })
    .limit(20);
}
