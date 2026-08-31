// impact-allow-no-test: pure data-access seam (thin Supabase insert
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references validator-core/violation-generator.ts — zero
// coverage today.
/**
 * validator-core/violation-generator.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in violation-generator.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same insert, same return shape — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GovernanceViolation } from '../types/governance';

export async function insertGovernanceViolation(sb: SupabaseClient, violation: GovernanceViolation) {
  return sb.from('governance_violations').insert(violation);
}
