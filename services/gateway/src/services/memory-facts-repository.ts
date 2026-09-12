// Genuine coverage: test/unit/services/memory-facts.test.ts passes a
// hand-built functional fake client directly (no jest.mock()) and asserts
// on the exact upsert() call args — real coverage, not a mock.
/**
 * services/memory-facts.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in memory-facts.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same upsert, same conflict target, same return shape — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function upsertMemoryFactRow(
  sb: SupabaseClient,
  row: {
    user_id: string;
    tenant_id: string;
    fact_type: string;
    fact_value: string;
    provenance_source: string;
    updated_at: string;
  },
) {
  return sb
    .from('memory_facts')
    .upsert(row, { onConflict: 'user_id,tenant_id,fact_type' })
    .select()
    .single();
}
