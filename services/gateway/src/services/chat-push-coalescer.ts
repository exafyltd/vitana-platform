/**
 * VTID-05137 — WhatsApp-style chat pushes: one push per conversation per burst.
 *
 * Owner report 2026-10-12: three messages from the same sender within a
 * minute became three separate cards in the Android tray. Phones receive chat
 * pushes through Appilix, whose push API has no tag/collapse/group parameter
 * (see NotificationPayload.tag in notification-service.ts), so the tray cannot
 * be told to replace a card — the only lever on the native apps is sending
 * fewer pushes.
 *
 * Rule: a recipient gets at most ONE push per conversation per
 * CHAT_PUSH_COALESCE_WINDOW_MS while the earlier pushed notification is still
 * unread. Reading the conversation (read_at set by the app) resets it at once.
 * Every message still writes its in-app row (the bell stays complete); a held
 * back message is recorded as push_outcome 'coalesced'. When a push does go
 * out and the recipient already has unread messages in that conversation, the
 * body becomes "{count} new messages · {preview}".
 *
 * Mentions always push (callers pass kind 'mention'). FCM/web-push paths also
 * get tag `chat:<key>` so a browser replaces the conversation's card instead
 * of stacking — that part does nothing for Appilix.
 *
 * The decision is the CALLER's: build the payloads, run them through
 * coalesceChatPushes(), then call notifyUser(..., opts) with what it returns.
 * notifyUser never calls this module.
 *
 * Fails open: any read error means "push as before".
 * Off switch: CHAT_PUSH_COALESCING_ENABLED=false.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NotificationPayload, NotifyUserOptions } from './notification-service';
import { tt } from '../i18n/catalog';
import { bulkGetUserLocales } from '../i18n/server-locale';

export const CHAT_PUSH_COALESCE_WINDOW_MS = 5 * 60 * 1000;
/** How far back unread rows count toward the "N new messages" summary. */
export const CHAT_PUSH_UNREAD_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const CHAT_PUSH_MAX_COUNT = 99;
const CHAT_NOTIFICATION_TYPES = ['new_chat_message', 'chat_mention'];
const ROW_LIMIT = 2000;

export function isChatPushCoalescingEnabled(): boolean {
  return (process.env.CHAT_PUSH_COALESCING_ENABLED ?? 'true') !== 'false';
}

/** `dm:<sender>` for a direct message, `group:<group>` for a group. */
export function chatConversationKey(input: { groupId?: string | null; senderId: string }): string {
  return input.groupId ? `group:${input.groupId}` : `dm:${input.senderId}`;
}

export function chatPushTag(conversationKey: string): string {
  return `chat:${conversationKey}`;
}

export interface ChatPushDecision {
  push: boolean;
  /** Unread messages in this conversation, including the new one. */
  unreadCount: number;
}

// Exported (VTID-05208) so new-member-greeting-push.ts reuses the same rows/rule.
export interface ChatNotificationRow {
  user_id: string;
  created_at: string;
  push_sent_at: string | null;
  push_outcome: string | null;
  data: Record<string, unknown> | null;
}

/** A row whose push actually went out (not held back, not suppressed). */
export function wasPushed(row: ChatNotificationRow): boolean {
  if (!row.push_sent_at) return false;
  if (row.data && row.data.push_coalesced === 'true') return false;
  const outcome = row.push_outcome || '';
  return outcome !== 'coalesced' && !outcome.startsWith('suppressed_');
}

/**
 * One batched read for every recipient of one message. Returns a decision per
 * recipient; on error every recipient gets { push: true, unreadCount: 1 }.
 */
export async function decideChatPushes(
  supabase: SupabaseClient<any, any, any>,
  recipientIds: string[],
  conversationKey: string,
  now: number = Date.now(),
): Promise<Map<string, ChatPushDecision>> {
  const decisions = new Map<string, ChatPushDecision>();
  for (const id of recipientIds) decisions.set(id, { push: true, unreadCount: 1 });
  if (recipientIds.length === 0 || !isChatPushCoalescingEnabled()) return decisions;

  let rows: ChatNotificationRow[];
  try {
    const { data, error } = await supabase
      .from('user_notifications')
      .select('user_id, created_at, push_sent_at, push_outcome, data')
      .in('user_id', recipientIds)
      .in('type', CHAT_NOTIFICATION_TYPES)
      .eq('data->>conversation_key', conversationKey)
      .is('read_at', null)
      .gte('created_at', new Date(now - CHAT_PUSH_UNREAD_LOOKBACK_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(ROW_LIMIT);
    if (error) throw new Error(error.message);
    rows = (data as ChatNotificationRow[] | null) ?? [];
  } catch (err: any) {
    console.warn(`[ChatPushCoalescer] read failed, pushing as before: ${err?.message || err}`);
    return decisions;
  }

  const windowStart = now - CHAT_PUSH_COALESCE_WINDOW_MS;
  for (const id of recipientIds) {
    const mine = rows.filter((r) => r.user_id === id);
    const pushedRecently = mine.some((r) => wasPushed(r) && Date.parse(r.created_at) >= windowStart);
    decisions.set(id, {
      push: !pushedRecently,
      unreadCount: Math.min(mine.length + 1, CHAT_PUSH_MAX_COUNT),
    });
  }
  return decisions;
}

export interface ChatPushItem {
  userId: string;
  payload: NotificationPayload;
  /** A mention always pushes. */
  kind: 'message' | 'mention';
}

export interface PreparedChatPush {
  userId: string;
  payload: NotificationPayload;
  opts?: NotifyUserOptions;
}

/**
 * Stamp each payload with the conversation key and tag, decide which pushes
 * go out, and turn the body of a push that follows unread messages into the
 * localized "{count} new messages · {preview}" summary.
 */
export async function coalesceChatPushes(
  supabase: SupabaseClient<any, any, any>,
  conversationKey: string,
  items: ChatPushItem[],
  now: number = Date.now(),
): Promise<PreparedChatPush[]> {
  const tag = chatPushTag(conversationKey);
  const decisions = await decideChatPushes(
    supabase,
    items.map((i) => i.userId),
    conversationKey,
    now,
  );

  const summaryIds = items
    .filter((i) => {
      const d = decisions.get(i.userId);
      return i.kind === 'message' && d?.push && d.unreadCount > 1;
    })
    .map((i) => i.userId);
  const locales = summaryIds.length > 0
    ? await bulkGetUserLocales(supabase, summaryIds).catch(() => new Map<string, string>())
    : new Map<string, string>();

  return items.map((item) => {
    const decision = decisions.get(item.userId) ?? { push: true, unreadCount: 1 };
    const payload: NotificationPayload = {
      ...item.payload,
      tag,
      data: { ...(item.payload.data || {}), conversation_key: conversationKey, tag },
    };
    if (item.kind === 'mention') return { userId: item.userId, payload };
    if (!decision.push) {
      return { userId: item.userId, payload, opts: { suppressPush: 'coalesced' } };
    }
    if (decision.unreadCount > 1) {
      payload.body = tt('notif.chat_burst.body', locales.get(item.userId), {
        count: decision.unreadCount,
        preview: item.payload.body,
      });
    }
    return { userId: item.userId, payload };
  });
}
