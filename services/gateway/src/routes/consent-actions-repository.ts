// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/consent-actions.ts — zero coverage
// today.
/**
 * routes/consent-actions.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in consent-actions.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserActionPermissions(sb: SupabaseClient, userId: string) {
  return sb.from('user_action_permissions').select('*').eq('user_id', userId).order('granted_at', { ascending: false });
}

export async function revokeUserActionPermission(sb: SupabaseClient, userId: string, actionType: string) {
  return sb
    .from('user_action_permissions')
    .update({ granted: false, revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('action_type', actionType);
}
