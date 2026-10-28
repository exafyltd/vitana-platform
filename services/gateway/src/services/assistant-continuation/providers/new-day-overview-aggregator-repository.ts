// Coverage note: test/services/assistant-continuation/providers/new-day-overview-aggregator.test.ts
// exercises this module against a functional fake Supabase client (no
// jest.mock of this repository module), so these wrappers get genuine
// coverage, not a documented zero.
/**
 * services/assistant-continuation/providers/new-day-overview-aggregator.ts
 * — Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in new-day-overview-aggregator.ts
 * now goes through here instead of being written inline. PURE MOVE, not
 * a rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchCalendarEventsInWindow(
  sb: SupabaseClient,
  args: { userId: string; gteIso: string; ltIso: string; limit: number },
) {
  return sb
    .from('calendar_events')
    .select('title, start_time, end_time, status')
    .eq('user_id', args.userId)
    .gte('start_time', args.gteIso)
    .lt('start_time', args.ltIso)
    .order('start_time', { ascending: false })
    .limit(args.limit);
}

export async function fetchCalendarEventsUpcoming(
  sb: SupabaseClient,
  args: { userId: string; gteIso: string; lteIso: string; limit: number },
) {
  return sb
    .from('calendar_events')
    .select('title, start_time, end_time, status')
    .eq('user_id', args.userId)
    .gte('start_time', args.gteIso)
    .lte('start_time', args.lteIso)
    .order('start_time', { ascending: true })
    .limit(args.limit);
}
