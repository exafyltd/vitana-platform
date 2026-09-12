// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references calendar-prep-analyzer.ts — zero coverage today.
/**
 * services/recommendation-engine/analyzers/calendar-prep-analyzer.ts —
 * Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md
 * Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in calendar-prep-analyzer.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 *
 * `buildCalendarPrepEventsQuery` returns only the query-initiating
 * `.from('calendar_events').select(...)...order().limit()` builder,
 * `: any` typed, so the source file's one conditional filter
 * (`opts.user_ids`) keeps mutating it in place exactly as before — the
 * same reasoning already applied to discover-search-repository.ts's
 * buildProductSearchQuery and its siblings.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export function buildCalendarPrepEventsQuery(
  sb: SupabaseClient,
  nowIso: string,
  horizonIso: string,
  limit: number,
): any {
  return sb
    .from('calendar_events')
    .select('id,user_id,tenant_id,start_time,pillar,event_type,status,source_type')
    .not('pillar', 'is', null)
    .neq('status', 'cancelled')
    .gte('start_time', nowIso)
    .lte('start_time', horizonIso)
    .order('start_time', { ascending: true })
    .limit(limit);
}
