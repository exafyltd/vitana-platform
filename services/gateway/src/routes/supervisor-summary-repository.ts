// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior); exercised
// indirectly by routes/supervisor-summary.ts's existing test suite
// (test/routes/supervisor-summary.test.ts), which mocks
// ../lib/supabase's getSupabase() with a functional table+topic-aware
// fake, not this module.
/**
 * routes/supervisor-summary.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchDatasetExtractionEvents(sb: SupabaseClient, sinceIso: string) {
  return sb.from('oasis_events').select('id, created_at, metadata').eq('topic', 'dataset.extraction.completed').gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(500);
}

export async function countShadowComparedEvents(sb: SupabaseClient, sinceIso: string) {
  return sb.from('oasis_events').select('id', { count: 'exact', head: true }).eq('topic', 'eval.shadow.compared').gte('created_at', sinceIso);
}

export async function fetchFinetuneCompletedEvents(sb: SupabaseClient) {
  return sb.from('oasis_events').select('id, created_at, metadata').eq('topic', 'finetune.training.completed').order('created_at', { ascending: false }).limit(100);
}

export async function fetchLatestCanaryLifecycleEvent(sb: SupabaseClient) {
  const topics = ['production.canary.requested', 'production.canary.started', 'production.canary.promoted', 'production.canary.aborted'];
  return sb.from('oasis_events').select('id, topic, created_at, metadata').in('topic', topics).order('created_at', { ascending: false }).limit(1);
}

export async function fetchAutoPromoteEvents(sb: SupabaseClient, sinceIso: string) {
  return sb.from('oasis_events').select('id, topic, created_at, metadata').in('topic', ['auto_promote.proposed', 'auto_promote.rejected']).gte('created_at', sinceIso).order('created_at', { ascending: false }).limit(50);
}

export async function countPendingBacklogTasks(sb: SupabaseClient) {
  return sb.from('vtid_ledger').select('vtid', { count: 'exact', head: true }).eq('status', 'pending').eq('is_terminal', false);
}
