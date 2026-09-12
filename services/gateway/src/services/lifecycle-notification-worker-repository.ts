// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references lifecycle-notification-worker.ts — zero coverage
// today.
/**
 * services/lifecycle-notification-worker.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in lifecycle-notification-worker.ts
 * now goes through here instead of being written inline. PURE MOVE, not
 * a rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUnnotifiedLifecycleStateSince(sb: SupabaseClient, sinceIso: string, limit: number) {
  return sb
    .from('lifecycle_notification_state')
    .select('user_id, tenant_id, lifecycle_kind, subscription_id, metadata, fired_at')
    .gte('fired_at', sinceIso)
    .is('notified_at', null)
    .limit(limit);
}

export async function markLifecycleStateNotified(sb: SupabaseClient, userId: string, lifecycleKind: string) {
  return sb
    .from('lifecycle_notification_state')
    .update({ notified_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('lifecycle_kind', lifecycleKind);
}
