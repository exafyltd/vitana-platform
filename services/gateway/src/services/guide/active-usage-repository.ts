/**
 * guide/active-usage.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/active-usage.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conflict keys, same return shapes —
 * no behavior change today. Client-agnostic (takes `supabase` as a param),
 * same convention as every other *-repository.ts in this codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_active_days ====================

export async function upsertActiveUsageDay(supabase: SupabaseClient, userId: string, activeDate: string) {
  return supabase
    .from('user_active_days')
    .upsert(
      { user_id: userId, active_date: activeDate },
      { onConflict: 'user_id,active_date', ignoreDuplicates: true },
    );
}

export async function countActiveUsageDaysForUser(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('user_active_days')
    .select('user_id', { count: 'exact', head: true })
    .eq('user_id', userId);
}
