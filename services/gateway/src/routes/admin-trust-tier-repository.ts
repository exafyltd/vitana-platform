// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/admin-trust-tier.ts — zero coverage
// today.
/**
 * routes/admin-trust-tier.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in admin-trust-tier.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same upsert options, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchProfileByVitanaId(sb: SupabaseClient, vitanaId: string) {
  return sb.from('profiles').select('user_id, vitana_id').eq('vitana_id', vitanaId).maybeSingle();
}

export async function upsertUserReputationTrustTier(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('user_reputation').upsert(row as any, { onConflict: 'vitana_id' });
}
