// impact-allow-no-test: pure data-access seam (thin Supabase query/insert
// wrappers, no independent request-handling behavior); exercised
// indirectly by livekit-test-runner.ts's existing test suite
// (test/services/voice-lab/livekit-test-runner.test.ts), which mocks only
// ../../lib/supabase (the client factory), not this module.
/**
 * services/voice-lab/livekit-test-runner.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in livekit-test-runner.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertLiveKitTestRun(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('livekit_test_runs').insert(row).select('id').single();
}

export async function updateLiveKitTestRunTotals(sb: SupabaseClient, runId: string, patch: Record<string, unknown>) {
  return sb.from('livekit_test_runs').update(patch).eq('id', runId);
}

export async function insertLiveKitTestResult(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('livekit_test_results').insert(row);
}

export async function fetchEnabledLiveKitTestCases(sb: SupabaseClient, caseKey: string | undefined, layer: 'A' | 'B') {
  let query = sb
    .from('livekit_test_cases')
    .select('id, key, label, prompt, expected, layer, enabled')
    .eq('enabled', true)
    .eq('layer', layer);
  if (caseKey) query = query.eq('key', caseKey);
  return query.order('key', { ascending: true });
}

export async function fetchRecentLiveKitTestRuns(sb: SupabaseClient, limit: number) {
  return sb
    .from('livekit_test_runs')
    .select('id, started_at, finished_at, trigger, layer, total, passed, failed, errored, duration_ms')
    .order('started_at', { ascending: false })
    .limit(limit);
}

export async function fetchLiveKitTestRunById(sb: SupabaseClient, runId: string) {
  return sb
    .from('livekit_test_runs')
    .select('id, started_at, finished_at, trigger, layer, total, passed, failed, errored, duration_ms')
    .eq('id', runId)
    .maybeSingle();
}

export async function fetchLiveKitTestResultsForRun(sb: SupabaseClient, runId: string) {
  return sb
    .from('livekit_test_results')
    .select('case_key, status, tool_calls, reply_text, expected, failure_reasons, error, latency_ms, retried, started_at, finished_at')
    .eq('run_id', runId)
    .order('case_key', { ascending: true });
}

export async function fetchAllLiveKitTestCases(sb: SupabaseClient) {
  return sb.from('livekit_test_cases').select('id, key, label, prompt, layer, enabled, notes').order('key', { ascending: true });
}
