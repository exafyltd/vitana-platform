/**
 * guide/session-summaries.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/session-summaries.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_session_summaries ====================

export async function fetchRecentSessionSummaries(supabase: SupabaseClient, userId: string, limit: number) {
  return supabase
    .from('user_session_summaries')
    .select('session_id, channel, summary, themes, turn_count, duration_ms, ended_at')
    .eq('user_id', userId)
    .order('ended_at', { ascending: false })
    .limit(limit);
}

export async function upsertSessionSummary(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_session_summaries').upsert(row, { onConflict: 'user_id,session_id' });
}

export async function fetchSessionSummariesInWindow(supabase: SupabaseClient, userId: string, fromIso: string, toIso: string) {
  return supabase
    .from('user_session_summaries')
    .select('session_id, channel, summary, themes, turn_count, duration_ms, ended_at')
    .eq('user_id', userId)
    .gte('ended_at', fromIso)
    .lt('ended_at', toIso)
    .order('ended_at', { ascending: true });
}
