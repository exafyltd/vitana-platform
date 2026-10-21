// Genuinely tested via test/services/journey/user-journey-service.test.ts
// and test/user-journey-service.test.ts, which drive real functional
// fake SupabaseClients (table-keyed builder mocks, not wholesale
// module mocks). test/services/guide/awareness-context.test.ts
// wholesale jest.mocks this module instead.
/**
 * services/journey/user-journey-service.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * journey/user-journey-service.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param) —
 * mirrors the source file's own existing convention of threading
 * `client: SupabaseClient` through its functions.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchUserJourneyRow(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_journey')
    .select(
      'user_id, tenant_id, started_at, total_days, plan_type, plan_summary, current_wave_id, ' +
        'current_milestone_id, status, completed_milestone_ids, is_first_session, last_session_date, ' +
        'last_acknowledged_day, recent_greeting_openings, plan_negotiated_at, created_at, updated_at',
    )
    .eq('user_id', userId)
    .maybeSingle();
}

export async function fetchAppUserForJourneyFallback(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('user_id, created_at').eq('user_id', userId).maybeSingle();
}

export async function insertUserJourneyRow(
  sb: SupabaseClient,
  row: { user_id: string; tenant_id: string | null; started_at: string; is_first_session: boolean },
) {
  return sb.from('user_journey').insert(row).select('user_id').maybeSingle();
}

export async function fetchUserJourneyRecentGreetingOpenings(sb: SupabaseClient, userId: string) {
  return sb.from('user_journey').select('recent_greeting_openings').eq('user_id', userId).maybeSingle();
}

export async function updateUserJourneyRow(sb: SupabaseClient, userId: string, update: Record<string, unknown>) {
  return sb.from('user_journey').update(update).eq('user_id', userId);
}
