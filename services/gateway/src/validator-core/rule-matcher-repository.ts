// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references validator-core/rule-matcher.ts — zero coverage
// today.
/**
 * validator-core/rule-matcher.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in rule-matcher.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter logic, same return
 * shape — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveGovernanceRules(sb: SupabaseClient, tenantId: string) {
  return sb.from('governance_rules').select('*').eq('is_active', true).eq('tenant_id', tenantId);
}
