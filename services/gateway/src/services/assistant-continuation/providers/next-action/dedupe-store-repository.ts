// Coverage note: test/services/assistant-continuation/providers/next-action/dedupe-store.test.ts
// exercises this module against a functional fake Supabase client
// passed directly as `inputs.supabase` (no jest.mock of this repository
// module), so these wrappers get genuine coverage, not a documented
// zero.
/**
 * services/assistant-continuation/providers/next-action/dedupe-store.ts
 * — Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in dedupe-store.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same upsert options, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchRecentDedupeSighting(
  sb: SupabaseClient,
  args: { tenantId: string; userId: string; signalName: string; cutoffIso: string },
) {
  return sb
    .from('user_assistant_state')
    .select('last_seen_at')
    .eq('tenant_id', args.tenantId)
    .eq('user_id', args.userId)
    .eq('signal_name', args.signalName)
    .gte('last_seen_at', args.cutoffIso)
    .limit(1);
}

export async function upsertDedupeSighting(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('user_assistant_state').upsert(row, { onConflict: 'tenant_id,user_id,signal_name' });
}
