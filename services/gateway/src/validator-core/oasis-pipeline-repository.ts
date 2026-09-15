/**
 * validator-core/oasis-pipeline.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The Supabase `.from(...)` call in oasis-pipeline.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * query, same columns, same return shape — no behavior change today.
 * Client-agnostic (takes `supabase` as a param), same convention as every
 * other *-repository.ts in this codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== oasis_events_v1 ====================

export async function insertOasisEventV1(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('oasis_events_v1').insert(row);
}
