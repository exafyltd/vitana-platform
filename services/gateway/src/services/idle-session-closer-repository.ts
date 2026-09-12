// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references idle-session-closer.ts — zero coverage today.
/**
 * services/idle-session-closer.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in idle-session-closer.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filters, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchRecentNonOrbConversationMessages(sb: SupabaseClient, lookbackIso: string) {
  return sb
    .from('conversation_messages')
    .select('thread_id, user_id, tenant_id, channel, created_at')
    .neq('channel', 'orb')
    .gte('created_at', lookbackIso)
    .order('created_at', { ascending: false })
    .limit(2000);
}

export async function fetchExistingSessionSummaries(sb: SupabaseClient, sessionIds: string[]) {
  return sb.from('user_session_summaries').select('session_id, user_id').in('session_id', sessionIds);
}

export async function fetchThreadTranscript(sb: SupabaseClient, threadId: string, limit: number) {
  return sb
    .from('conversation_messages')
    .select('role, content, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
    .limit(limit);
}
