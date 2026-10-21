// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior); exercised
// indirectly by routes/chat.ts's existing test suite
// (test/chat-vitana-reply.test.ts), which mocks @supabase/supabase-js's
// createClient with a stateful chainable fake, not this module.
/**
 * routes/chat.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in this file now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries/RPC names, same columns, same conditional-
 * filter logic, same return shapes — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertChatMessage(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('chat_messages').insert(row).select().single();
}

export async function fetchSenderProfile(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('display_name, email').eq('user_id', userId).maybeSingle();
}

export async function fetchConversationMessages(
  sb: SupabaseClient,
  tenantId: string | null,
  userId: string,
  peerId: string,
  limit: number,
  before: string | undefined,
) {
  let query = sb
    .from('chat_messages')
    .select('*')
    .eq('tenant_id', tenantId)
    .or(`and(sender_id.eq.${userId},receiver_id.eq.${peerId}),and(sender_id.eq.${peerId},receiver_id.eq.${userId})`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) {
    query = query.lt('created_at', before);
  }

  return query;
}

export async function getRecentConversationsRpc(sb: SupabaseClient, params: { p_user_id: string; p_tenant_id: string | null; p_limit: number }) {
  return sb.rpc('get_recent_conversations', params);
}

export async function fetchConversationsFallback(sb: SupabaseClient, tenantId: string | null, userId: string, limit: number) {
  return sb
    .from('chat_messages')
    .select('*')
    .eq('tenant_id', tenantId)
    .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
    // DM rows only — mirrors the RPC. Group messages share this table with
    // receiver_id NULL + group_id set, and would dedup to a peer_id of
    // `undefined`, producing an inbox entry with no peer.
    .not('receiver_id', 'is', null)
    .is('group_id', null)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export async function markPeerMessagesRead(sb: SupabaseClient, tenantId: string | null, peerId: string, userId: string) {
  return sb.from('chat_messages').update({ read_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('sender_id', peerId).eq('receiver_id', userId).is('read_at', null);
}

export async function markAllMessagesRead(sb: SupabaseClient, tenantId: string | null, userId: string) {
  return sb.from('chat_messages').update({ read_at: new Date().toISOString() }, { count: 'exact' }).eq('tenant_id', tenantId).eq('receiver_id', userId).is('read_at', null);
}

export async function countUnreadMessages(sb: SupabaseClient, tenantId: string | null, userId: string) {
  return sb.from('chat_messages').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('receiver_id', userId).is('read_at', null);
}

export async function fetchVitanaDmHistoryRows(sb: SupabaseClient, tenantId: string, userId: string, botUserId: string, limit: number) {
  return sb
    .from('chat_messages')
    .select('sender_id, content, created_at')
    .eq('tenant_id', tenantId)
    .or(`and(sender_id.eq.${userId},receiver_id.eq.${botUserId}),and(sender_id.eq.${botUserId},receiver_id.eq.${userId})`)
    .order('created_at', { ascending: false })
    .limit(limit);
}

export function insertVitanaReplyMessage(sb: SupabaseClient, row: Record<string, unknown>): PromiseLike<{ error: { message?: string } | null }> {
  return sb.from('chat_messages').insert(row);
}

// ─── VTID-05310 (messenger-ux-v2/api-send-reliability) ────────────────────
// Idempotent sends (client_message_id), persisted reply targets, delivered_at
// and a context window around one message. Used by routes/chat.ts and
// routes/chat-groups.ts. Every helper degrades to today's behaviour when the
// migration 20261021140000_vtid_05310_chat_send_reliability.sql is not
// applied yet (unknown column → PostgREST PGRST204 / Postgres 42703).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

type PgError = { code?: string; message?: string } | null | undefined;

/** The insert hit the (sender_id, client_message_id) unique index. */
export function isUniqueViolation(err: PgError): boolean {
  return !!err && err.code === '23505';
}

/** A column this lane adds does not exist yet (migration not applied). */
export function isMissingColumn(err: PgError, column: string): boolean {
  if (!err) return false;
  if (err.code !== 'PGRST204' && err.code !== '42703') return false;
  return (err.message || '').includes(column);
}

/**
 * A send that carries a client_message_id: if that id is already stored, the
 * stored row (duplicate) — or a conflict when the stored row belongs to another
 * conversation (a reused id must never swallow a new message silently).
 */
export async function findPriorSend(
  sb: SupabaseClient,
  senderId: string,
  clientMessageId: string,
  scope: ConversationScope,
): Promise<{ kind: 'none' } | { kind: 'duplicate'; row: any } | { kind: 'conflict' }> {
  const { data, error } = await findMessageByClientId(sb, senderId, clientMessageId);
  if (error || !data) return { kind: 'none' };
  return rowInScope(data as ScopeRow, scope) ? { kind: 'duplicate', row: data } : { kind: 'conflict' };
}

/** Client content_data must never set a reply target; only a validated reply_to_message_id does. */
export function stripClientReplyTo(metadata: Record<string, unknown>): Record<string, unknown> {
  if (!('reply_to' in metadata)) return metadata;
  const { reply_to: _ignored, ...rest } = metadata;
  return rest;
}

export async function findMessageByClientId(sb: SupabaseClient, senderId: string, clientMessageId: string) {
  return sb
    .from('chat_messages')
    .select('*')
    .eq('sender_id', senderId)
    .eq('client_message_id', clientMessageId)
    .maybeSingle();
}

export type ConversationScope = { kind: 'dm'; a: string; b: string } | { kind: 'group'; groupId: string };

type ScopeRow = { id: string; sender_id: string; receiver_id: string | null; group_id: string | null };

export function rowInScope(row: ScopeRow, scope: ConversationScope): boolean {
  if (scope.kind === 'group') return row.group_id === scope.groupId;
  if (row.group_id) return false;
  return (
    (row.sender_id === scope.a && row.receiver_id === scope.b) ||
    (row.sender_id === scope.b && row.receiver_id === scope.a)
  );
}

export async function fetchMessageScopeRows(sb: SupabaseClient, ids: string[]) {
  return sb.from('chat_messages').select('id, sender_id, receiver_id, group_id, created_at').in('id', ids);
}

export type SendIdentity = { client_message_id?: string; reply_to_message_id?: string };

/**
 * Validates the optional VTID-05310 send fields. Returns the metadata patch
 * (`reply_to`) and the column value (`client_message_id`), or an error code.
 * A reply target must be a message of the same conversation.
 */
export async function resolveSendIdentity(
  sb: SupabaseClient,
  body: { client_message_id?: unknown; reply_to_message_id?: unknown },
  scope: ConversationScope,
): Promise<{ ok: true; clientMessageId: string | null; replyTo: string | null } | { ok: false; error: string }> {
  let clientMessageId: string | null = null;
  if (body.client_message_id !== undefined && body.client_message_id !== null) {
    if (!isUuid(body.client_message_id)) return { ok: false, error: 'invalid_client_message_id' };
    clientMessageId = body.client_message_id.toLowerCase();
  }
  let replyTo: string | null = null;
  if (body.reply_to_message_id !== undefined && body.reply_to_message_id !== null) {
    if (!isUuid(body.reply_to_message_id)) return { ok: false, error: 'invalid_reply_target' };
    const { data, error } = await fetchMessageScopeRows(sb, [body.reply_to_message_id]);
    const row = !error && Array.isArray(data) ? (data[0] as ScopeRow | undefined) : undefined;
    if (!row || !rowInScope(row, scope)) return { ok: false, error: 'invalid_reply_target' };
    replyTo = row.id;
  }
  return { ok: true, clientMessageId, replyTo };
}

/**
 * Insert with idempotency. `duplicate: true` means the row already existed
 * (pre-check or the unique index lost a race) and the caller must not push.
 * Without the migration the insert is retried without client_message_id.
 */
export async function insertChatMessageIdempotent(
  sb: SupabaseClient,
  row: Record<string, unknown>,
  clientMessageId: string | null,
  insert: (sb: SupabaseClient, row: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>,
  scope?: ConversationScope,
): Promise<{ data: any; error: any; duplicate: boolean; conflict?: boolean }> {
  const senderId = row.sender_id as string;
  if (clientMessageId) {
    const existing = await findMessageByClientId(sb, senderId, clientMessageId);
    if (!existing.error && existing.data) {
      if (scope && !rowInScope(existing.data as ScopeRow, scope)) return { data: null, error: null, duplicate: false, conflict: true };
      return { data: existing.data, error: null, duplicate: true };
    }
  }
  const withId = clientMessageId ? { ...row, client_message_id: clientMessageId } : row;
  const first = await insert(sb, withId);
  if (!first.error) return { data: first.data, error: null, duplicate: false };
  if (clientMessageId && isUniqueViolation(first.error)) {
    const again = await findMessageByClientId(sb, senderId, clientMessageId);
    if (!again.error && again.data) {
      if (scope && !rowInScope(again.data as ScopeRow, scope)) return { data: null, error: null, duplicate: false, conflict: true };
      return { data: again.data, error: null, duplicate: true };
    }
    return { data: null, error: first.error, duplicate: false };
  }
  if (clientMessageId && isMissingColumn(first.error, 'client_message_id')) {
    const retry = await insert(sb, row);
    return { data: retry.data, error: retry.error, duplicate: false };
  }
  return { data: null, error: first.error, duplicate: false };
}

/**
 * Read-side trust boundary for replies (I1): `metadata.reply_to` can be forged
 * by a direct RLS insert, so a row exposes `reply_to_message_id` only when the
 * target is in the same conversation. One batched lookup per page.
 */
export async function annotateReplyTargets<T extends Record<string, any>>(
  sb: SupabaseClient,
  rows: T[] | null | undefined,
  scope: ConversationScope,
): Promise<Array<T & { reply_to_message_id: string | null }>> {
  const list = rows ?? [];
  const wanted = Array.from(new Set(
    list.map((r) => r?.metadata?.reply_to?.message_id).filter((id: unknown): id is string => isUuid(id)),
  ));
  const inScope = new Set<string>();
  if (wanted.length > 0) {
    const known = new Map(list.map((r) => [r.id, r as unknown as ScopeRow]));
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length > 0) {
      const { data, error } = await fetchMessageScopeRows(sb, missing);
      if (!error) for (const r of (data as ScopeRow[] | null) ?? []) known.set(r.id, r);
    }
    for (const id of wanted) {
      const r = known.get(id);
      if (r && rowInScope(r, scope)) inScope.add(id);
    }
  }
  return list.map((r) => {
    const target = r?.metadata?.reply_to?.message_id;
    return { ...r, reply_to_message_id: isUuid(target) && inScope.has(target) ? target : null };
  });
}

export async function markMessagesDelivered(sb: SupabaseClient, tenantId: string | null, userId: string, ids: string[]) {
  return sb
    .from('chat_messages')
    .update({ delivered_at: new Date().toISOString() }, { count: 'exact' })
    .eq('tenant_id', tenantId)
    .eq('receiver_id', userId)
    .in('id', ids)
    .is('delivered_at', null);
}

/** /chat/read also fills a NULL delivered_at (I2). Best effort before the migration. */
export async function markPeerMessagesDelivered(sb: SupabaseClient, tenantId: string | null, peerId: string, userId: string) {
  return sb
    .from('chat_messages')
    .update({ delivered_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('sender_id', peerId)
    .eq('receiver_id', userId)
    .is('delivered_at', null);
}

function dmFilter(userId: string, peerId: string) {
  return `and(sender_id.eq.${userId},receiver_id.eq.${peerId}),and(sender_id.eq.${peerId},receiver_id.eq.${userId})`;
}

/** Forward paging: messages newer than `after`, ascending. */
export async function fetchConversationMessagesAfter(
  sb: SupabaseClient,
  tenantId: string | null,
  userId: string,
  peerId: string,
  limit: number,
  after: string,
) {
  return sb
    .from('chat_messages')
    .select('*')
    .eq('tenant_id', tenantId)
    .or(dmFilter(userId, peerId))
    .gt('created_at', after)
    .order('created_at', { ascending: true })
    .limit(limit);
}

export type WindowResult = { data: any[]; has_older: boolean; has_newer: boolean } | { notFound: true } | { error: any };

/**
 * I3: up to limit/2 rows before (and including) the target and up to limit/2
 * after it, ascending. `scopeQuery` builds the conversation-restricted base
 * query, so a target outside the conversation is "not found".
 */
export async function fetchWindowAround(
  sb: SupabaseClient,
  scopeQuery: () => any,
  aroundId: string,
  limit: number,
): Promise<WindowResult> {
  const target = await scopeQuery().eq('id', aroundId).maybeSingle();
  if (target.error) return { error: target.error };
  if (!target.data) return { notFound: true };
  const half = Math.max(1, Math.floor(limit / 2));
  const at = target.data.created_at as string;
  const [older, newer] = await Promise.all([
    scopeQuery().lt('created_at', at).order('created_at', { ascending: false }).limit(half + 1),
    scopeQuery().gt('created_at', at).order('created_at', { ascending: true }).limit(half + 1),
  ]);
  if (older.error) return { error: older.error };
  if (newer.error) return { error: newer.error };
  const olderRows = (older.data as any[]) ?? [];
  const newerRows = (newer.data as any[]) ?? [];
  return {
    data: [...olderRows.slice(0, half).reverse(), target.data, ...newerRows.slice(0, half)],
    has_older: olderRows.length > half,
    has_newer: newerRows.length > half,
  };
}

export function dmScopeQuery(sb: SupabaseClient, tenantId: string | null, userId: string, peerId: string): () => any {
  return () => sb.from('chat_messages').select('*').eq('tenant_id', tenantId).or(dmFilter(userId, peerId));
}
