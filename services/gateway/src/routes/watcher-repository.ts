// impact-allow-no-test
// Genuinely tested via test/watcher.test.ts, which drives a functional
// stub Supabase client (a from()-chain resolving to a configurable
// {data,error,count} response) — not a wholesale module mock.
/**
 * routes/watcher.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in watcher.ts now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchWatcherTimeline(
  sb: SupabaseClient,
  args: { vtid: string; workUnitId: string; limit: number },
) {
  let query = sb
    .from('watcher_steps')
    .select('id, work_unit_kind, work_unit_id, vtid, step, outcome, actor, evidence, source, source_ref, observed_at')
    .order('observed_at', { ascending: true })
    .limit(args.limit);

  query = args.vtid ? query.eq('vtid', args.vtid) : query.eq('work_unit_id', args.workUnitId);

  return query;
}

export async function fetchWatcherObserverState(sb: SupabaseClient) {
  return sb
    .from('watcher_observer_state')
    .select('source, cursor_at, last_run_at, last_error, last_written, updated_at')
    .order('source', { ascending: true });
}

export async function countAllWatcherLessons(sb: SupabaseClient) {
  return sb.from('watcher_lessons').select('id', { count: 'exact', head: true });
}

export async function countInjectableWatcherLessons(sb: SupabaseClient) {
  return sb
    .from('watcher_lessons')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
    .gt('frequency', 1);
}
