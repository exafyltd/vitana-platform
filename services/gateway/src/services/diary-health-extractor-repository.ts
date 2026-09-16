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
 * `writeDiaryHealthSignalFact` deliberately stays a plain query
 * function (not wrapped in `.then()`) — the caller attaches its own
 * `.then(...)` for the fire-and-forget error log, exactly as the
 * source did.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function upsertHealthFeatureDaily(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('health_features_daily').upsert(row, { onConflict: 'tenant_id,user_id,date,feature_key' });
}

export async function writeDiaryHealthSignalFact(
  sb: SupabaseClient,
  args: {
    p_tenant_id: string;
    p_user_id: string;
    p_fact_key: string;
    p_fact_value: string;
    p_entity: string;
    p_fact_value_type: string;
    p_provenance_source: string;
    p_provenance_confidence: number;
  },
) {
  return sb.rpc('write_fact', args);
}
