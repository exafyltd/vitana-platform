/**
 * continuity/continuity-fetcher.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in continuity-fetcher.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same filters/ordering, same return shapes —
 * no behavior change today. Client-agnostic (takes `supabase` as a param),
 * same convention as every other *-repository.ts in this codebase.
 *
 * B2 wall note (unchanged from the source file): this stays READ-ONLY —
 * no insert/update/upsert/delete/rpc (see the B2 wall-integrity test at
 * test/services/continuity/b2-walls.test.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PromiseStatus } from './types';

// ==================== user_open_threads ====================

export async function fetchOpenThreads(supabase: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return supabase
    .from('user_open_threads')
    .select(
      'thread_id, topic, summary, status, session_id_first, session_id_last, last_mentioned_at, resolved_at, created_at, updated_at',
    )
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('last_mentioned_at', { ascending: false })
    .limit(limit);
}

// ==================== assistant_promises ====================

export async function fetchAssistantPromises(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  limit: number,
  status?: PromiseStatus,
) {
  let q = supabase
    .from('assistant_promises')
    .select(
      'promise_id, thread_id, session_id, promise_text, due_at, status, decision_id, kept_at, created_at, updated_at',
    )
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);
  return q;
}
