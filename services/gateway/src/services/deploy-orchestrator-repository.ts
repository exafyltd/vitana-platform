// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: all
// four referencing test files (operator-chat-oasis, task-extractor,
// operator-command, autopilot-pipeline) wholesale jest.mock() this
// module — zero genuine coverage today.
/**
 * services/deploy-orchestrator.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in deploy-orchestrator.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same filters, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveSystemGovernanceRules(sb: SupabaseClient) {
  return sb
    .from('governance_rules')
    .select('*')
    .eq('tenant_id', 'SYSTEM')
    .eq('is_active', true);
}
