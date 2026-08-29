/**
 * journey-stage/journey-stage-fetcher.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in journey-stage-fetcher.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same filters/ordering, same return shapes —
 * no behavior change today. Client-agnostic (takes `supabase` as a param),
 * same convention as every other *-repository.ts in this codebase.
 *
 * B4 wall note: this file, like journey-stage-fetcher.ts itself, must stay
 * READ-ONLY — no insert/update/upsert/delete/rpc (see the B4 wall-integrity
 * test at test/services/journey-stage/b4-walls.test.ts, which greps
 * journey-stage-fetcher.ts's own source, not this file — do not reintroduce
 * a write here either).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== app_users ====================

export async function fetchAppUserById(supabase: SupabaseClient, userId: string) {
  return supabase
    .from('app_users')
    .select('user_id, created_at')
    .eq('user_id', userId)
    .maybeSingle();
}

// ==================== user_active_days ====================

export async function fetchUserActiveDays(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase
    .from('user_active_days')
    .select('active_date')
    .eq('user_id', userId)
    .order('active_date', { ascending: false })
    .limit(limit);
}

// ==================== vitana_index_scores ====================

export async function fetchVitanaIndexHistory(supabase: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return supabase
    .from('vitana_index_scores')
    .select('date, score_total')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(limit);
}
