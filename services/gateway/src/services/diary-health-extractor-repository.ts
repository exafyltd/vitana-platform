// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note:
// the one referencing test (test/save-diary-entry-shared.test.ts)
// wholesale jest.mocks diary-health-extractor.ts — zero genuine
// coverage today.
/**
 * services/diary-health-extractor.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * diary-health-extractor.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same params, same return shapes — no behavior change
 * today. Client-agnostic (takes `sb` as a param).
 *
 * The diary→memory fact write moved to the shared rememberFact() path
 * (VTID-04364).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function upsertHealthFeatureDaily(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('health_features_daily').upsert(row, { onConflict: 'tenant_id,user_id,date,feature_key' });
}
