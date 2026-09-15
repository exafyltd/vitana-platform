// Genuine coverage: test/orb/live/session/chat-bridge-reliability.test.ts
// passes a hand-built functional fake client directly (no jest.mock()
// of the client) and asserts on insert() call counts across retries —
// real coverage, not a mock.
/**
 * orb/live/session/upstream-message-handler.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in upstream-message-handler.ts
 * now goes through here instead of being written inline. PURE MOVE,
 * not a rewrite: same insert, same row shape, same return shape — the
 * retry loop, error handling, and OASIS-event-on-failure logic in the
 * source file are completely untouched. No behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertChatMessage(
  sb: SupabaseClient,
  row: {
    tenant_id: string;
    sender_id: string;
    receiver_id: string;
    content: string;
    message_type: string;
    metadata: Record<string, unknown>;
    created_at: string;
    read_at?: string;
  },
) {
  return sb.from('chat_messages').insert(row);
}
