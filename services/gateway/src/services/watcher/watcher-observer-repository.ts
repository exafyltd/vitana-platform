// impact-allow-no-test: pure data-access seam (thin Supabase query/upsert
// wrappers, no independent request-handling behavior); exercised
// indirectly by watcher-observer.ts's existing test suite
// (test/watcher-observer.test.ts), which mocks only ../../lib/supabase
// (the client factory), not this module — genuine coverage of every call
// site here.
/**
 * services/watcher/watcher-observer.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in watcher-observer.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchObserverCursor(sb: SupabaseClient, source: string) {
  return sb.from('watcher_observer_state').select('cursor_at').eq('source', source).maybeSingle();
}

export async function upsertObserverCursor(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('watcher_observer_state').upsert(row, { onConflict: 'source' });
}

export async function upsertWatcherSteps(sb: SupabaseClient, steps: unknown[]) {
  return sb
    .from('watcher_steps')
    .upsert(steps, { onConflict: 'source,source_ref,step', ignoreDuplicates: true })
    .select('id, work_unit_kind, work_unit_id, vtid, step, outcome, actor, evidence, source, source_ref, observed_at');
}

export async function fetchOasisEventsPage(sb: SupabaseClient, from: string, topicFilter: string, rangeStart: number, rangeEnd: number) {
  return sb
    .from('oasis_events')
    .select('id, topic, vtid, status, message, service, source, metadata, created_at')
    .gte('created_at', from)
    .or(topicFilter)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(rangeStart, rangeEnd);
}

export async function fetchDevAutopilotExecutions(sb: SupabaseClient, from: string, limit: number) {
  return sb
    .from('dev_autopilot_executions')
    // Kept on one line deliberately: supabase-js parses the select string at
    // the TYPE level, and a concatenated expression defeats that parse — it
    // degrades the row type to GenericStringError[] and the cast at the call
    // site then fails to compile. Do not "tidy" this into a multi-line concat.
    .select('id, status, finding_id, branch, pr_url, pr_number, failure_stage, self_healing_vtid, parent_execution_id, auto_fix_depth, updated_at')
    .gte('updated_at', from)
    .order('updated_at', { ascending: true })
    .limit(limit);
}

export async function fetchFailedWatcherStepsSince(sb: SupabaseClient, sinceIso: string, limit: number) {
  return sb
    .from('watcher_steps')
    .select('id, work_unit_kind, work_unit_id, vtid, step, outcome, actor, evidence, source, source_ref, observed_at')
    .eq('outcome', 'failure')
    .gte('observed_at', sinceIso)
    .order('observed_at', { ascending: true })
    .limit(limit);
}
