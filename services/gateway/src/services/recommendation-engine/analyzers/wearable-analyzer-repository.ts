// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references wearable-analyzer.ts — zero coverage today.
/**
 * services/recommendation-engine/analyzers/wearable-analyzer.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in wearable-analyzer.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic (takes
 * `sb` as a param).
 *
 * `fetchWearableRollup7d` resolves the terminal await inside an async
 * function (rather than returning a partial builder) so the source's
 * optional `user_ids` conditional `.in()` step still runs before the
 * query executes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveTenantIdForUser(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle();
}

export async function fetchWearableRollup7d(sb: SupabaseClient, args: { userIds?: string[]; limit: number }) {
  let query = sb
    .from('wearable_rollup_7d')
    .select('*')
    .gte('days_with_data', 3)
    .limit(args.limit);
  if (args.userIds?.length) {
    query = query.in('user_id', args.userIds);
  }
  return query;
}
