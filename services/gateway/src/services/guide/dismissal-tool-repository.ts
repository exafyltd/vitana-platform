/**
 * guide/dismissal-tool.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in guide/dismissal-tool.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `supabase` as
 * a param), same convention as every other *-repository.ts in this
 * codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== user_proactive_pause ====================

export async function insertProactivePause(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_proactive_pause').insert(row).select().single();
}

export async function clearActivePausesForUser(supabase: SupabaseClient, userId: string, nowIso: string) {
  return supabase.from('user_proactive_pause').update({ paused_until: nowIso }).eq('user_id', userId).gt('paused_until', nowIso).select('id');
}

// ==================== user_nudge_state ====================

export async function upsertNudgeSilence(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('user_nudge_state').upsert(row, { onConflict: 'user_id,nudge_key' });
}
