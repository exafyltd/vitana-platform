/**
 * VTID-05208 — grouped pushes for new-member greeting DMs (plan S4, owner D2 = b).
 *
 * A newcomer can be greeted by many members at once: each greeting is a
 * private DM sent on explicit Send through POST /api/v1/chat/send and tagged
 * `metadata.source = 'new_member_greeting'`. The VTID-05137 coalescer keys
 * pushes per conversation (`dm:<sender>`), so 200 greeters would still mean
 * 200 pushes. This module adds a second, RECIPIENT-keyed rule for tagged DMs:
 *
 *   - the first greeting DM in a 24 h window pushes normally;
 *   - later greeting DMs in that window write their in-app row (the bell
 *     stays complete, one row per greeter) but do not push
 *     (push_outcome 'coalesced');
 *   - a push that goes out while other greetings are still within 24 h reads
 *     "{count} people said hello 👋" in the recipient's language (tt()).
 *
 * The window is anchored on the last greeting push that really went out and
 * does NOT reset on read (unlike chat coalescing): the point is one greeting
 * push a day, however the newcomer reacts.
 *
 * Grouping fails OPEN: a read error, or NEW_MEMBER_GREETING_PUSH_GROUPING_ENABLED
 * = 'false', falls back to exactly today's per-conversation coalescing.
 *
 * Test/service/automation accounts (CLAUDE.md rules 43–45, VTID-03991) are
 * excluded fail-CLOSED, independent of the off switch: if the exclusion
 * lookup fails, or the sender or receiver is a registered test/service
 * account, prepareNewMemberGreetingPush() returns null and the caller writes
 * no notification at all for that DM.
 *
 * The caller decides: run the payload through prepareNewMemberGreetingPush(),
 * then call notifyUser(..., opts) with what it returns (skip on null).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NotificationPayload } from './notification-service';
import {
  CHAT_PUSH_MAX_COUNT,
  chatConversationKey,
  chatPushTag,
  coalesceChatPushes,
  wasPushed,
  type ChatNotificationRow,
  type PreparedChatPush,
} from './chat-push-coalescer';
import { fetchExcludedTestServiceAccountIdsStrict } from '../lib/excluded-test-service-accounts';
import { tt } from '../i18n/catalog';
import { getUserLocale } from '../i18n/server-locale';

export const NEW_MEMBER_GREETING_SOURCE = 'new_member_greeting';
export const GREETING_PUSH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GREETING_PUSH_TAG = chatPushTag(NEW_MEMBER_GREETING_SOURCE);
export const GREETING_GROUP_KEY = 'greeting_group';
const GREETING_ROW_LIMIT = 500;

/** True only for a DM tagged exactly `metadata.source = 'new_member_greeting'`. */
export function isNewMemberGreeting(metadata: Record<string, unknown> | null | undefined): boolean {
  return !!metadata && metadata.source === NEW_MEMBER_GREETING_SOURCE;
}

export function isGreetingPushGroupingEnabled(): boolean {
  return (process.env.NEW_MEMBER_GREETING_PUSH_GROUPING_ENABLED ?? 'true') !== 'false';
}

export interface GreetingPushDecision {
  push: boolean;
  /** Distinct greeters in the window, including this sender (capped). */
  greeterCount: number;
}

/**
 * One read of the receiver's greeting rows in the last 24 h. Returns null on
 * a read error so the caller can fall back to per-conversation coalescing.
 */
export async function decideGreetingPush(
  supabase: SupabaseClient<any, any, any>,
  receiverId: string,
  senderId: string,
  now: number = Date.now(),
): Promise<GreetingPushDecision | null> {
  const windowStart = now - GREETING_PUSH_WINDOW_MS;
  let rows: ChatNotificationRow[];
  try {
    const { data, error } = await supabase
      .from('user_notifications')
      .select('user_id, created_at, push_sent_at, push_outcome, data')
      .eq('user_id', receiverId)
      .in('type', ['new_chat_message'])
      .eq(`data->>${GREETING_GROUP_KEY}`, NEW_MEMBER_GREETING_SOURCE)
      .gte('created_at', new Date(windowStart).toISOString())
      .order('created_at', { ascending: false })
      .limit(GREETING_ROW_LIMIT);
    if (error) throw new Error(error.message);
    rows = (data as ChatNotificationRow[] | null) ?? [];
  } catch (err: any) {
    console.warn(`[GreetingPush] read failed, falling back to chat coalescing: ${err?.message || err}`);
    return null;
  }

  const pushedInWindow = rows.some((r) => wasPushed(r) && Date.parse(r.created_at) >= windowStart);
  const greeters = new Set<string>([senderId]);
  for (const r of rows) {
    const s = r.data?.sender_id;
    if (typeof s === 'string' && s) greeters.add(s);
  }
  return { push: !pushedInWindow, greeterCount: Math.min(greeters.size, CHAT_PUSH_MAX_COUNT) };
}

const shortId = (id: string) => id.slice(0, 8);

export async function prepareNewMemberGreetingPush(
  supabase: SupabaseClient<any, any, any>,
  input: { senderId: string; receiverId: string; payload: NotificationPayload },
  now: number = Date.now(),
): Promise<PreparedChatPush | null> {
  const { senderId, receiverId } = input;

  // 1) Test/service accounts — fail closed, never bypassed by the off switch.
  const excluded = await fetchExcludedTestServiceAccountIdsStrict(supabase);
  if (!excluded.ok) {
    console.warn(`[GreetingPush] skipped: exclusion lookup failed (${excluded.error})`);
    return null;
  }
  if (excluded.ids.has(senderId) || excluded.ids.has(receiverId)) {
    console.warn(
      `[GreetingPush] skipped: test/service account (sender ${shortId(senderId)}, receiver ${shortId(receiverId)})`,
    );
    return null;
  }

  const conversationKey = chatConversationKey({ senderId });
  const fallback = async (): Promise<PreparedChatPush> =>
    (await coalesceChatPushes(supabase, conversationKey, [{ userId: receiverId, payload: input.payload, kind: 'message' }], now))[0];

  // 2) Off switch → today's per-conversation behaviour.
  if (!isGreetingPushGroupingEnabled()) return fallback();

  // 3) Recipient-keyed 24 h decision; a read error fails open.
  const decision = await decideGreetingPush(supabase, receiverId, senderId, now);
  if (!decision) return fallback();

  // 4) Stamp the payload so later greetings find this row.
  const payload: NotificationPayload = {
    ...input.payload,
    tag: GREETING_PUSH_TAG,
    data: {
      ...(input.payload.data || {}),
      conversation_key: conversationKey,
      tag: GREETING_PUSH_TAG,
      [GREETING_GROUP_KEY]: NEW_MEMBER_GREETING_SOURCE,
      greeting_count: String(decision.greeterCount),
    },
  };

  // 5) Held back, summarised, or unchanged.
  if (!decision.push) return { userId: receiverId, payload, opts: { suppressPush: 'coalesced' } };
  if (decision.greeterCount > 1) {
    const locale = await getUserLocale(supabase, receiverId).catch(() => undefined);
    payload.title = tt('notif.new_member_greeting_burst.title', locale);
    payload.body = tt('notif.new_member_greeting_burst.body', locale, { count: decision.greeterCount });
  }
  return { userId: receiverId, payload };
}
