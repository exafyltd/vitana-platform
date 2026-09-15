// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// many test files depend on policy-resolver.ts's behavior, but all of
// them do so via configurePolicyResolverForTests() — a test seam that
// injects a static in-memory cache snapshot and never calls fetchAll(),
// so the actual .from() call sites here are never exercised — zero
// genuine coverage today.
/**
 * services/decision-contract/policy-resolver.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in policy-resolver.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same return shapes — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAllDecisionPolicyRows(sb: SupabaseClient) {
  return sb.from('decision_policy').select('policy_key, tenant_id, version, value_json, effective_from, effective_until');
}

export async function fetchAllPolicyRenderBlockRows(sb: SupabaseClient) {
  return sb.from('policy_render_block').select('block_key, language, tenant_id, version, content, effective_from, effective_until');
}
