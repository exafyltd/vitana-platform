// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// test/routes/conversation-hub.test.ts deliberately forces
// getSupabase() => null so all DB-backed endpoints take their 503
// branch — the actual .from() calls this file owns are never exercised
// — zero genuine coverage today.
/**
 * routes/conversation-hub.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in conversation-hub.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchOasisEventsByStage(sb: SupabaseClient, stage: string, sinceIso: string, limit: number) {
  return sb
    .from('oasis_events')
    .select('created_at, metadata')
    .eq('topic', 'orb.live.diag')
    .eq('metadata->>stage', stage)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit);
}

// VTID-04371: the hourly rollup. PostgREST caps a response at 1000 rows, so
// the read pages until a short page (at most MAX_METRIC_PAGES pages).
const METRIC_PAGE = 1000;
const MAX_METRIC_PAGES = 40;

export async function fetchConversationMetricsSince(sb: SupabaseClient, sinceIso: string) {
  const rows: Array<Record<string, unknown>> = [];
  for (let page = 0; page < MAX_METRIC_PAGES; page++) {
    const from = page * METRIC_PAGE;
    const { data, error } = await sb
      .from('conversation_metrics_hourly')
      .select('hour_start, metric, dimension, value, sample_count, computed_at')
      .gte('hour_start', sinceIso)
      .order('hour_start', { ascending: true })
      .order('metric', { ascending: true })
      .order('dimension', { ascending: true })
      .range(from, from + METRIC_PAGE - 1);
    if (error) return { data: null, error };
    rows.push(...((data as Array<Record<string, unknown>>) || []));
    if (!data || data.length < METRIC_PAGE) break;
  }
  return { data: rows, error: null };
}

export async function fetchConversationMetricSeries(sb: SupabaseClient, metric: string, dimension: string, sinceIso: string) {
  return sb
    .from('conversation_metrics_hourly')
    .select('hour_start, metric, dimension, value, sample_count, computed_at')
    .eq('metric', metric)
    .eq('dimension', dimension)
    .gte('hour_start', sinceIso)
    .order('hour_start', { ascending: true })
    .limit(1000);
}

export async function fetchLearningAutomationRuns(sb: SupabaseClient, automationIds: readonly string[]) {
  return sb
    .from('automation_runs')
    .select('automation_id, status, started_at, completed_at, error_message')
    .in('automation_id', automationIds as string[])
    .order('started_at', { ascending: false })
    .limit(500);
}

export async function fetchProfileNarrativeStamps(sb: SupabaseClient, signalName: string) {
  return sb
    .from('user_assistant_state')
    // Only stamps and counts: the narrative text itself never leaves the DB here.
    // VTID-04438: + schema version, sections filled and input counts.
    .select('generated_at:value->>generated_at, schema_version:value->>schema_version, sections_filled:value->>sections_filled, summaries:value->inputs_counts->>summaries, diary:value->inputs_counts->>diary, outcome_providers:value->inputs_counts->>outcome_providers')
    .eq('signal_name', signalName)
    .limit(5000);
}

/**
 * VTID-04444 (WS-4.2): diary theme rollup coverage for Learning health.
 * Stamps and counts only — the themes themselves never leave the DB here.
 */
export async function fetchDiaryThemeStamps(sb: SupabaseClient, signalName: string) {
  return sb
    .from('user_assistant_state')
    .select('generated_at:value->>generated_at, theme_count:value->>theme_count, entries_considered:value->>entries_considered')
    .eq('signal_name', signalName)
    .limit(5000);
}

/**
 * VTID-04525 (Conversation hub B3): one topic (optionally a set of diag
 * stages) over a window, newest first, paged in 1000-row pages up to
 * `maxRows`. Uses the (topic, created_at DESC) index; the stage filter runs on
 * top of that. `truncated` says the window held more rows than were read.
 */
export async function fetchOasisTopicWindow(
  sb: SupabaseClient,
  opts: { topic: string; stages?: readonly string[]; sinceIso: string; maxRows: number },
): Promise<{ data: Array<{ created_at: string; metadata: Record<string, unknown> | null }> | null; truncated: boolean; error: { message: string } | null }> {
  const PAGE = 1000;
  const rows: Array<{ created_at: string; metadata: Record<string, unknown> | null }> = [];
  const pages = Math.max(1, Math.ceil(opts.maxRows / PAGE));
  for (let page = 0; page < pages; page++) {
    const from = page * PAGE;
    let q = sb
      .from('oasis_events')
      .select('created_at, metadata')
      .eq('topic', opts.topic)
      .gte('created_at', opts.sinceIso);
    if (opts.stages && opts.stages.length) q = q.in('metadata->>stage', [...opts.stages]);
    const { data, error } = await q.order('created_at', { ascending: false }).range(from, from + PAGE - 1);
    if (error) return { data: null, truncated: false, error };
    rows.push(...((data as Array<{ created_at: string; metadata: Record<string, unknown> | null }>) || []));
    if (!data || data.length < PAGE) return { data: rows, truncated: false, error: null };
  }
  return { data: rows, truncated: true, error: null };
}

/** VTID-04525: the latest `conversation.system.snapshot` events for one stack, newest first. */
export async function fetchSystemSnapshotEvents(sb: SupabaseClient, env: string, limit: number) {
  return sb
    .from('oasis_events')
    .select('created_at, metadata')
    .eq('topic', 'conversation.system.snapshot')
    .eq('metadata->>env', env)
    .order('created_at', { ascending: false })
    .limit(limit);
}
