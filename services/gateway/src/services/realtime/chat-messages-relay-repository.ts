/**
 * B5 realtime relay — `chat_messages` (Supabase→Aurora migration
 * workstream, see docs/AURORA-B5-REALTIME-INVENTORY.md's 2026-09-11
 * addenda). Deliberately NOT built on `generic-cursor-relay.ts`: that
 * module's authorization model is "row ownership by column equality",
 * but `chat_messages` shares one table between two different
 * conversation shapes (confirmed against the existing
 * `chat-repository.ts`/`chat-groups-repository.ts` read paths):
 *
 *   - Direct messages: `sender_id`/`receiver_id` columns, `group_id` NULL.
 *   - Group messages: `group_id` set, `receiver_id` NULL. Visibility is
 *     membership in `chat_group_members`, a JOIN, not a column match.
 *
 * A caller may see a row if they are its DM sender/receiver, OR a current
 * member of its group — an OR across two different join shapes, which is
 * exactly what `generic-cursor-relay.ts`'s own scoping note (in this same
 * addendum) says would be the wrong abstraction to force through.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface RowCursor {
  sinceCreatedAt: string;
  sinceId: string | null;
}

/**
 * The group ids a user currently belongs to — re-fetched on every poll
 * tick (see chat-messages-poller.ts) rather than cached for the life of
 * the connection, so a mid-session group join/leave is reflected without
 * requiring a reconnect.
 */
export async function fetchUserGroupIds(sb: SupabaseClient, userId: string): Promise<{ groupIds: string[]; error: { message: string } | null }> {
  const { data, error } = await sb.from('chat_group_members').select('group_id').eq('user_id', userId);
  if (error) return { groupIds: [], error: { message: error.message } };
  return { groupIds: (data ?? []).map((row: { group_id: string }) => row.group_id), error: null };
}

/**
 * Fetch chat_messages rows the caller may see — DMs they sent or
 * received, plus messages in any group in `groupIds` — created strictly
 * after `cursor`, oldest-first, capped at `limit`. `groupIds` must be the
 * CURRENT membership list (see fetchUserGroupIds), not a stale snapshot.
 */
export async function fetchChatMessagesSinceCursor(
  sb: SupabaseClient,
  tenantId: string | null,
  userId: string,
  groupIds: string[],
  cursor: RowCursor,
  limit: number,
) {
  const visibilityClauses = [`sender_id.eq.${userId}`, `receiver_id.eq.${userId}`];
  if (groupIds.length > 0) {
    visibilityClauses.push(`group_id.in.(${groupIds.join(',')})`);
  }

  let query: any = sb.from('chat_messages').select('*').eq('tenant_id', tenantId).or(visibilityClauses.join(','));

  query = cursor.sinceId
    ? query.or(
        `created_at.gt.${cursor.sinceCreatedAt},and(created_at.eq.${cursor.sinceCreatedAt},id.gt.${cursor.sinceId})`,
      )
    : query.gt('created_at', cursor.sinceCreatedAt);

  return query.order('created_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
}
