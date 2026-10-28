// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly by
// routes/admin-memory-broker.ts's existing test suite
// (test/routes/admin-memory-broker.test.ts), which covers every route
// group here (38 passing tests).
/**
 * routes/admin-memory-broker.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/admin-memory-broker.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 *
 * The four imported functions this route calls (getMemoryContext,
 * buildAgentProfile, runConsolidator, getSystemControl) are defined in
 * other service modules — their own internal Supabase calls, if any, are
 * NOT part of this file's `.from()` surface and are out of scope here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== generic row-count helper ====================
// Used for both the /admin/memory/health table-count sweep (15 tables)
// and the /admin/memory/embeddings collection-count sweep (3 collections)
// — same query shape, different table name, so one parameterized function
// covers both call sites instead of one named function per table.

export async function countTableRows(sb: SupabaseClient, table: string) {
  return sb.from(table).select('*', { count: 'exact', head: true });
}

// ==================== /admin/memory/health ====================

export async function fetchRecentConsolidatorRuns(sb: SupabaseClient) {
  return sb
    .from('consolidator_runs')
    .select('id, triggered_by, triggered_at, finished_at, status, summary, tenant_id')
    .order('triggered_at', { ascending: false })
    .limit(10);
}

export async function fetchRecentMemoryEvents(sb: SupabaseClient, since: string) {
  return sb
    .from('oasis_events')
    .select('id, topic, vtid, status, message, payload, created_at, source')
    .or('topic.ilike.memory.%,topic.ilike.orb.memory.%')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(25);
}

export async function fetchIdentityLockAttempts(sb: SupabaseClient) {
  return sb
    .from('oasis_events')
    .select('id, topic, vtid, status, message, payload, created_at')
    .ilike('topic', 'memory.identity.%')
    .order('created_at', { ascending: false })
    .limit(10);
}

// ==================== /admin/memory/graph-sample ====================

export async function fetchMemGraphEdgesSample(sb: SupabaseClient, userId: string | null) {
  let q = sb
    .from('mem_graph_edges')
    .select('id, tenant_id, user_id, source_kind, source_id, edge_type, target_kind, target_id, strength, asserted_at')
    .order('asserted_at', { ascending: false })
    .limit(50);
  if (userId) q = q.eq('user_id', userId);
  return q;
}

export async function fetchLegacyRelationshipEdgesSample(sb: SupabaseClient, userId: string | null) {
  let q = sb
    .from('relationship_edges')
    .select('id, tenant_id, source_type, source_id, target_type, target_id, edge_type, strength, last_interaction_at')
    .order('last_interaction_at', { ascending: false, nullsFirst: false })
    .limit(50);
  if (userId) q = q.eq('source_id', userId);
  return q;
}
