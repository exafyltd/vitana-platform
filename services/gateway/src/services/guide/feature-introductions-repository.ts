/**
 * guide/feature-introductions.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/feature-introductions.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conflict keys, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_feature_introductions ====================

export async function fetchFeatureIntroductions(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('user_feature_introductions')
    .select('feature_key, introduced_at, channel')
    .eq('user_id', userId)
    .order('introduced_at', { ascending: false })
    .limit(50);
}

export async function upsertFeatureIntroduction(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_feature_introductions').upsert(row, { onConflict: 'user_id,feature_key' });
}
