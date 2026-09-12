// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/emotional-cognitive.ts — zero coverage
// today.
/**
 * routes/emotional-cognitive.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * emotional-cognitive.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same calls, same params,
 * same filter logic, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function meContextRpc(sb: SupabaseClient) {
  return sb.rpc('me_context');
}

export async function fetchActiveEmotionalCognitiveRules(sb: SupabaseClient) {
  return sb
    .from('emotional_cognitive_rules')
    .select('rule_key, rule_version, domain, target_state, weight, decay_minutes, active')
    .eq('active', true)
    .order('domain')
    .order('weight', { ascending: false });
}
