/**
 * VTID-02771 — Voice Tool Expansion P1i: Chat / DM read tools.
 *
 * Backs voice tools that surface the user's DM inbox beyond the
 * existing send_chat_message + resolve_recipient + share_link write
 * primitives. Each helper enforces user_id ownership at the table level.
 */

import { SupabaseClient } from '@supabase/supabase-js';

export interface ChatPeer {
  user_id: string;
  display_name?: string | null;
  unread: number;
  last_message_at: string;
  last_preview?: string | null;
}

export interface ChatMessage {
  id: string;
  from_user_id: string;
  to_user_id: string;
  body: string;
  created_at: string;
  read_at?: string | null;
}

// ---------------------------------------------------------------------------
// 1. list_conversations — peers + unread counts
// ---------------------------------------------------------------------------

export async function listConversations(
  sb: SupabaseClient,
  userId: string,
  args: { limit?: number },
): Promise<{ ok: true; conversations: ChatPeer[]; count: number } | { ok: false; error: string }> {
  const limit = Math.max(1, Math.min(50, args.limit ?? 20));

  // Pull recent message rows for this user (sent or received), then bucket
  // by counterparty. Rate-of-change is acceptable since list endpoints are
  // read-only and not heavy in the typical inbox.
  const { data, error } = await sb
    .from('chat_messages')
    .select('id, from_user_id, to_user_id, body, created_at, read_at')
    .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return { ok: false, error: `chat_query_failed: ${error.message}` };

  const peers = new Map<string, ChatPeer>();
  for (const m of (data || []) as any[]) {
    const peerId = String(m.from_user_id) === userId ? String(m.to_user_id) : String(m.from_user_id);
    const isInbound = String(m.to_user_id) === userId;
    const existing = peers.get(peerId);
    if (existing) {
      if (isInbound && !m.read_at) existing.unread += 1;
      continue;
    }
    peers.set(peerId, {
      user_id: peerId,
      display_name: null, // hydrated below
      unread: isInbound && !m.read_at ? 1 : 0,
      last_message_at: String(m.created_at),
      last_preview: String(m.body ?? '').slice(0, 200),
    });
    if (peers.size >= limit) break;
  }

  // Hydrate display names from app_users.
  if (peers.size > 0) {
    const ids = Array.from(peers.keys());
    const { data: users } = await sb
      .from('app_users')
      .select('user_id, display_name')
      .in('user_id', ids);
    for (const u of (users || []) as any[]) {
      const p = peers.get(String(u.user_id));
      if (p) p.display_name = u.display_name ?? null;
    }
  }

  const list = Array.from(peers.values()).sort(
    (a, b) => +new Date(b.last_message_at) - +new Date(a.last_message_at),
  );
  return { ok: true, conversations: list, count: list.length };
}

// ---------------------------------------------------------------------------
// 2. open_conversation — recent messages with one peer
// ---------------------------------------------------------------------------

export async function openConversation(
  sb: SupabaseClient,
  userId: string,
  args: { peer_user_id: string; limit?: number },
): Promise<{ ok: true; messages: ChatMessage[]; count: number } | { ok: false; error: string }> {
  if (!args.peer_user_id) return { ok: false, error: 'peer_user_id_required' };
  const limit = Math.max(1, Math.min(100, args.limit ?? 30));
  const { data, error } = await sb
    .from('chat_messages')
    .select('id, from_user_id, to_user_id, body, created_at, read_at')
    .or(
      `and(from_user_id.eq.${userId},to_user_id.eq.${args.peer_user_id}),and(from_user_id.eq.${args.peer_user_id},to_user_id.eq.${userId})`,
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { ok: false, error: `conversation_query_failed: ${error.message}` };
  const messages: ChatMessage[] = (data || []).map((m: any) => ({
    id: String(m.id),
    from_user_id: String(m.from_user_id),
    to_user_id: String(m.to_user_id),
    body: String(m.body ?? '').slice(0, 600),
    created_at: String(m.created_at),
    read_at: m.read_at ?? null,
  }));
  // Return chronological order (oldest → newest) for natural narration.
  messages.reverse();
  return { ok: true, messages, count: messages.length };
}

// ---------------------------------------------------------------------------
// 3. mark_conversation_read — bulk-mark inbound messages from peer as read
// ---------------------------------------------------------------------------

export async function markConversationRead(
  sb: SupabaseClient,
  userId: string,
  args: { peer_user_id: string },
): Promise<{ ok: true; updated: number } | { ok: false; error: string }> {
  if (!args.peer_user_id) return { ok: false, error: 'peer_user_id_required' };
  const { data, error } = await sb
    .from('chat_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('from_user_id', args.peer_user_id)
    .eq('to_user_id', userId)
    .is('read_at', null)
    .select('id');
  if (error) return { ok: false, error: `mark_read_failed: ${error.message}` };
  return { ok: true, updated: (data || []).length };
}

// ---------------------------------------------------------------------------
// 4. get_unread_count — total unread messages for the user
// ---------------------------------------------------------------------------

export async function getUnreadCount(
  sb: SupabaseClient,
  userId: string,
): Promise<{ ok: true; total_unread: number } | { ok: false; error: string }> {
  const { count, error } = await sb
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('to_user_id', userId)
    .is('read_at', null);
  if (error) return { ok: false, error: `unread_count_failed: ${error.message}` };
  return { ok: true, total_unread: count ?? 0 };
}
