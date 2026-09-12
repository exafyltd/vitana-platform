// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// no test file references routes/conversation.ts — zero coverage
// today.
/**
 * routes/conversation.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/conversation.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertConversationMessage(
  sb: SupabaseClient,
  row: {
    thread_id: string;
    tenant_id: string;
    user_id: string;
    role: string;
    channel: string;
    content: string;
    metadata: Record<string, unknown>;
  },
) {
  return sb.from('conversation_messages').insert(row).select('id').single();
}

/**
 * Server-side active_role verification for the developer_assistant
 * channel gate. Shared by both /turn and /stream — identical query,
 * identical params — per the sweep's one-function-per-identical-query
 * convention within a single source file.
 */
export async function fetchVerifiedActiveRole(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb.from('user_tenants').select('active_role').eq('user_id', userId).eq('tenant_id', tenantId).limit(1).single();
}

export async function fetchConversationHistoryQuery(sb: SupabaseClient, threadId: string, limit: number, before: string | undefined) {
  let query = sb
    .from('conversation_messages')
    .select('id, thread_id, role, channel, content, metadata, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (before) {
    query = query.lt('created_at', before);
  }

  return query;
}

export async function fetchLatestConversationMessageForThread(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('conversation_messages')
    .select('thread_id, created_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);
}
