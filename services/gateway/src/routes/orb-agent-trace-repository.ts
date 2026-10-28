// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/orb-agent-trace.ts — zero coverage
// today.
/**
 * routes/orb-agent-trace.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-agent-trace.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 *
 * `fetchUserTracesSince` preserves the source's optional phase filter.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertAgentTraceEvent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('oasis_events').insert(row);
}

export async function fetchUserTracesSince(
  sb: SupabaseClient,
  args: { topic: string; userId: string; sinceIso: string; limit: number; phaseFilter: string | null },
) {
  let query = sb
    .from('oasis_events')
    .select('id, topic, metadata, created_at')
    .eq('topic', args.topic)
    .filter('metadata->>user_id', 'eq', args.userId)
    .gte('created_at', args.sinceIso)
    .order('created_at', { ascending: false })
    .limit(args.limit);
  if (args.phaseFilter) {
    query = query.filter('metadata->>phase', 'eq', args.phaseFilter);
  }
  return query;
}

export async function fetchRecentTracesForTopic(sb: SupabaseClient, topic: string, sinceIso: string, limit: number) {
  return sb
    .from('oasis_events')
    .select('id, topic, metadata, created_at')
    .eq('topic', topic)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit);
}
