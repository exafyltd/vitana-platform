/**
 * orb/orb-session-state.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-session-state.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conflict keys, same return shapes —
 * no behavior change today. Client-agnostic (takes `supabase` as a
 * param), same convention as every other *-repository.ts in this
 * codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const TABLE = 'orb_session_state';

// ==================== orb_session_state ====================

export async function fetchOrbSessionStateValue(supabase: SupabaseClient, userId: string, key: string) {
  return supabase
    .from(TABLE)
    .select('value, expires_at')
    .eq('user_id', userId)
    .eq('key', key)
    .maybeSingle();
}

export async function upsertOrbSessionStateValue(
  supabase: SupabaseClient,
  row: { user_id: string; key: string; value: unknown; expires_at: string; updated_at: string },
) {
  return supabase.from(TABLE).upsert(row, { onConflict: 'user_id,key' });
}

export async function deleteOrbSessionStateValue(supabase: SupabaseClient, userId: string, key: string) {
  return supabase.from(TABLE).delete().eq('user_id', userId).eq('key', key);
}
