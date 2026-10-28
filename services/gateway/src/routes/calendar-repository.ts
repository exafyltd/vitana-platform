// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/calendar.ts — zero coverage today.
/**
 * routes/calendar.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in calendar.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same calls, same params, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { recordIndexRecompute } from '../services/vitana-index/record-recompute';

export async function fetchVitanaIndexScoresForUserDate(sb: SupabaseClient, userId: string, date: string) {
  return sb
    .from('vitana_index_scores')
    .select('score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental')
    .eq('user_id', userId)
    .eq('date', date)
    .maybeSingle();
}

/** VTID-05168: locked + recorded recompute for a calendar completion. */
export async function recordCalendarIndexRecompute(sb: SupabaseClient, userId: string, date: string, eventId: string | null) {
  return recordIndexRecompute(sb, {
    userId,
    date,
    trigger: 'calendar_completion',
    sourceKind: eventId ? 'calendar_event' : null,
    sourceRef: eventId,
  });
}

/** VTID-05168: the movement recorded for one source (null before the migration is applied). */
export async function fetchIndexMovementForSource(sb: SupabaseClient, userId: string, sourceKind: string, sourceRef: string) {
  const res = await sb
    .from('vitana_index_movements')
    .select('delta_total, delta_pillars, before, after, at')
    .eq('user_id', userId)
    .eq('source_kind', sourceKind)
    .eq('source_ref', sourceRef)
    .order('at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return { data: res?.error ? null : (res?.data ?? null) };
}
