/**
 * VTID-05312 (messenger-ux-v2/api-viewing-presence) — no chat push for the
 * conversation the recipient is looking at (owner requirement R13).
 *
 * The client posts a heartbeat (POST /api/v1/chat/viewing) every 20 s while a
 * conversation is open, visible and focused; each row lives 45 s. A push to
 * recipient R is suppressed when R has an unexpired row for that conversation
 * on any device or tab:
 *   - DM from sender S → key `dm:<S>` (the other party R sees is S — the same
 *     convention as chat-push-coalescer's chatConversationKey);
 *   - group G → key `group:<G>`.
 *
 * The check runs at the two places every chat push passes — notifyUser and the
 * /push-dispatch cron — so no push caller changes. One batched presence read
 * per call / per cron batch. Fails open: a read error means "push as before".
 * Off switch: CHAT_PUSH_VIEWING_SUPPRESSION_ENABLED=false.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const VIEWING_TTL_MS = 45_000;
export const CHAT_PUSH_TYPES: ReadonlySet<string> = new Set(['new_chat_message', 'chat_mention']);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const CONVERSATION_KEY_RE = new RegExp(`^(dm|group):${UUID}$`, 'i');
const UUID_RE = new RegExp(`^${UUID}$`, 'i');

export function isChatViewingSuppressionEnabled(): boolean {
  return (process.env.CHAT_PUSH_VIEWING_SUPPRESSION_ENABLED ?? 'true') !== 'false';
}

type Data = Record<string, unknown> | null | undefined;

/**
 * The conversation a chat notification belongs to, from the recipient's view:
 * group_id first, then sender_id. `data.conversation_key` is only a cross-check
 * (a mismatch is logged; the ids win). null = unknown (looked up by message id
 * by the caller, or not suppressed).
 */
export function chatConversationKeyFromData(data: Data): string | null {
  if (!data) return null;
  const groupId = typeof data.group_id === 'string' && UUID_RE.test(data.group_id) ? data.group_id : null;
  const senderId = typeof data.sender_id === 'string' && UUID_RE.test(data.sender_id) ? data.sender_id : null;
  const key = groupId ? `group:${groupId}` : senderId ? `dm:${senderId}` : null;
  const claimed = typeof data.conversation_key === 'string' ? data.conversation_key : null;
  if (key && claimed && claimed !== key) {
    console.warn(`[ChatViewing] conversation_key ${claimed} disagrees with the payload ids (${key}); using ${key}`);
  }
  return key;
}

export function messageIdOf(data: Data): string | null {
  const id = data && typeof data.message_id === 'string' ? data.message_id : null;
  return id && UUID_RE.test(id) ? id : null;
}

/** Keys for notifications whose payload names neither group nor sender: one chat_messages read. */
export async function keysByMessageId(
  sb: SupabaseClient<any, any, any>,
  messageIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(messageIds)).filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return out;
  try {
    const { data, error } = await sb.from('chat_messages').select('id, sender_id, group_id').in('id', ids);
    if (error) throw new Error(error.message);
    for (const r of (data as Array<{ id: string; sender_id: string; group_id: string | null }> | null) ?? []) {
      out.set(r.id, r.group_id ? `group:${r.group_id}` : `dm:${r.sender_id}`);
    }
  } catch (err: any) {
    console.warn(`[ChatViewing] message lookup failed, not suppressing: ${err?.message || err}`);
  }
  return out;
}

/** The Set key of a viewed (user, tenant, conversation). */
export function viewingKey(userId: string, tenantId: string | null | undefined, key: string): string {
  return `${userId}|${tenantId ?? ''}|${key}`;
}

/**
 * Which (user, tenant, key) triples are being viewed right now. One read for
 * all of them. The presence row must be of the push's tenant (plan I4); a push
 * without a tenant is never suppressed. Returns a Set of viewingKey(...).
 * Errors → empty set (push as before).
 */
export async function viewingPairs(
  sb: SupabaseClient<any, any, any>,
  pairs: Array<{ userId: string; tenantId: string | null | undefined; key: string }>,
  now: number = Date.now(),
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!isChatViewingSuppressionEnabled()) return out;
  const scoped = pairs.filter((p) => !!p.tenantId);
  const wanted = new Set(scoped.map((p) => viewingKey(p.userId, p.tenantId, p.key)));
  const userIds = Array.from(new Set(scoped.map((p) => p.userId)));
  const tenantIds = Array.from(new Set(scoped.map((p) => p.tenantId as string)));
  if (userIds.length === 0) return out;
  try {
    const { data, error } = await sb
      .from('chat_viewing_presence')
      .select('user_id, tenant_id, conversation_key, expires_at')
      .in('user_id', userIds)
      .in('tenant_id', tenantIds)
      .gt('expires_at', new Date(now).toISOString());
    if (error) throw new Error(error.message);
    for (const r of (data as Array<{ user_id: string; tenant_id: string | null; conversation_key: string; expires_at: string }> | null) ?? []) {
      const k = viewingKey(r.user_id, r.tenant_id, r.conversation_key);
      if (wanted.has(k) && new Date(r.expires_at).getTime() > now) out.add(k);
    }
  } catch (err: any) {
    console.warn(`[ChatViewing] presence read failed, pushing as before: ${err?.message || err}`);
  }
  return out;
}

/** Is `userId` viewing the conversation of this chat notification? (one read) */
export async function isViewingChat(
  sb: SupabaseClient<any, any, any>,
  userId: string,
  tenantId: string | null | undefined,
  type: string,
  data: Data,
  now: number = Date.now(),
): Promise<boolean> {
  if (!CHAT_PUSH_TYPES.has(type) || !isChatViewingSuppressionEnabled() || !tenantId) return false;
  let key = chatConversationKeyFromData(data);
  if (!key) {
    const mid = messageIdOf(data);
    if (mid) key = (await keysByMessageId(sb, [mid])).get(mid) ?? null;
  }
  if (!key) return false;
  const viewing = await viewingPairs(sb, [{ userId, tenantId, key }], now);
  return viewing.has(viewingKey(userId, tenantId, key));
}
