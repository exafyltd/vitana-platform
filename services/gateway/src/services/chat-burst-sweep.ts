/**
 * VTID-05718 — chat burst sweep (owner Option A, 2026-11-11).
 *
 * A chat message is held for CHAT_PUSH_BURST_HOLD_MS (chat-push-coalescer.ts) and written with
 * push_outcome 'pending_burst' and data.burst_due_at. When a burst is due, this sweep sends ONE
 * push per recipient and conversation: the body is the newest unread message, prefixed with the
 * unread count ("{count} new messages · {preview}") when there is more than one.
 *
 * Durability: the held state lives in user_notifications, so a restart or rolling deploy leaves
 * the rows in place and the next sweep on any task sends them. Several tasks may sweep at once;
 * each row is claimed with an atomic update (push_outcome 'pending_burst' -> 'sending'), so a burst
 * is sent once. A claim older than CHAT_BURST_STALE_CLAIM_MS is reclaimed (crash between claim and
 * dispatch). Read during the hold: no unread message left -> nothing is sent (suppressed_read).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { tt } from '../i18n/catalog';
import { bulkGetUserLocales } from '../i18n/server-locale';
import { dispatchPush } from './push-routing';
import { isNotificationTypeAllowed } from './notification-controls/notification-controls-service';
import {
  classifyPushOutcome,
  newPushFanoutOutcome,
  type NotificationPayload,
  type PushOutcome,
} from './notification-service';
import {
  CHAT_BURST_PENDING,
  CHAT_PUSH_MAX_COUNT,
  chatPushBurstHoldMs,
  chatPushTag,
  isChatPushCoalescingEnabled,
} from './chat-push-coalescer';

export const CHAT_BURST_SWEEP_INTERVAL_MS = 5_000;
export const CHAT_BURST_STALE_CLAIM_MS = 60_000;
const CHAT_BURST_SENDING = 'sending';
const CHAT_NOTIFICATION_TYPES = ['new_chat_message', 'chat_mention'];
const ROW_LIMIT = 500;
const INTERNAL_DATA_KEYS = ['burst_due_at', 'claimed_at'];

type Sb = SupabaseClient<any, any, any>;

interface BurstRow {
  id: string;
  user_id: string;
  tenant_id: string;
  type: string;
  title: string;
  body: string;
  created_at: string;
  data: Record<string, unknown> | null;
}

/** FCM data must be string values; internal keys never leave the server. */
export function burstPayloadData(data: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (INTERNAL_DATA_KEYS.includes(k) || v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

let sweeping = false;

/** Start the in-process sweep. Returns false (not started) when coalescing or the hold is off. */
export function startChatBurstSweep(getSupabase: () => Sb | null): boolean {
  if (!isChatPushCoalescingEnabled() || chatPushBurstHoldMs() === 0) return false;
  const timer = setInterval(() => {
    if (sweeping) return;
    const sb = getSupabase();
    if (!sb) return;
    sweeping = true;
    sweepChatBurstsOnce(sb)
      .catch((err: any) => console.warn(`[ChatBurst] sweep failed: ${err?.message || err}`))
      .finally(() => {
        sweeping = false;
      });
  }, CHAT_BURST_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return true;
}

/** One pass: reclaim stale claims, then flush every burst whose hold has expired. */
export async function sweepChatBurstsOnce(
  sb: Sb,
  now: number = Date.now(),
): Promise<{ flushed: number; suppressed: number }> {
  await reclaimStaleClaims(sb, now);
  const nowIso = new Date(now).toISOString();
  const { data: due, error } = await sb
    .from('user_notifications')
    .select('user_id, data')
    .eq('push_outcome', CHAT_BURST_PENDING)
    .lte('data->>burst_due_at', nowIso)
    .limit(ROW_LIMIT);
  if (error) throw new Error(error.message);

  const groups = new Map<string, { userId: string; key: string }>();
  for (const row of (due ?? []) as Array<{ user_id: string; data: Record<string, unknown> | null }>) {
    const key = String(row.data?.conversation_key ?? '');
    if (key) groups.set(`${row.user_id}|${key}`, { userId: row.user_id, key });
  }

  let flushed = 0;
  let suppressed = 0;
  for (const g of groups.values()) {
    const r = await flushGroup(sb, g.userId, g.key, now);
    flushed += r.pushed;
    suppressed += r.suppressed;
  }
  return { flushed, suppressed };
}

async function reclaimStaleClaims(sb: Sb, now: number): Promise<void> {
  const cutoff = new Date(now - CHAT_BURST_STALE_CLAIM_MS).toISOString();
  const { data, error } = await sb
    .from('user_notifications')
    .select('id, data')
    .eq('push_outcome', CHAT_BURST_SENDING)
    .lt('data->>claimed_at', cutoff)
    .limit(ROW_LIMIT);
  if (error) {
    console.warn(`[ChatBurst] stale-claim read failed: ${error.message}`);
    return;
  }
  for (const row of (data ?? []) as Array<{ id: string; data: Record<string, unknown> | null }>) {
    const rest: Record<string, unknown> = { ...(row.data ?? {}) };
    delete rest.claimed_at;
    rest.burst_due_at = new Date(now).toISOString();
    await sb
      .from('user_notifications')
      .update({ push_outcome: CHAT_BURST_PENDING, data: rest })
      .eq('id', row.id)
      .eq('push_outcome', CHAT_BURST_SENDING);
  }
}

async function flushGroup(
  sb: Sb,
  userId: string,
  key: string,
  now: number,
): Promise<{ pushed: number; suppressed: number }> {
  const nowIso = new Date(now).toISOString();

  // Claim every held row of this burst, not only the due ones, so the burst leaves as one push.
  const { data: held, error: heldErr } = await sb
    .from('user_notifications')
    .select('id, user_id, tenant_id, title, body, created_at, data')
    .eq('user_id', userId)
    .eq('push_outcome', CHAT_BURST_PENDING)
    .eq('data->>conversation_key', key)
    .limit(ROW_LIMIT);
  if (heldErr) throw new Error(heldErr.message);

  const claimed: BurstRow[] = [];
  for (const row of (held ?? []) as BurstRow[]) {
    const { data: got, error: claimErr } = await sb
      .from('user_notifications')
      .update({ push_outcome: CHAT_BURST_SENDING, data: { ...(row.data ?? {}), claimed_at: nowIso } })
      .eq('id', row.id)
      .eq('push_outcome', CHAT_BURST_PENDING)
      .select('id');
    if (claimErr) {
      console.warn(`[ChatBurst] claim failed for ${row.id}: ${claimErr.message}`);
      continue;
    }
    if (got && got.length > 0) claimed.push(row);
  }
  if (claimed.length === 0) return { pushed: 0, suppressed: 0 };

  // What the recipient still has unread in this conversation, newest first.
  const { data: unreadRaw, error: unreadErr } = await sb
    .from('user_notifications')
    .select('id, user_id, tenant_id, type, title, body, created_at, data')
    .eq('user_id', userId)
    .in('type', CHAT_NOTIFICATION_TYPES)
    .eq('data->>conversation_key', key)
    .is('read_at', null)
    .order('created_at', { ascending: false })
    .limit(ROW_LIMIT);
  // Fail open: a read error sends the burst from the claimed rows.
  const unread = (unreadErr
    ? [...claimed].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    : ((unreadRaw ?? []) as BurstRow[]));

  if (unread.length === 0) {
    await markClaimed(sb, claimed, 'suppressed_read', null);
    return { pushed: 0, suppressed: claimed.length };
  }

  const newest = unread[0];
  const count = Math.min(unread.length, CHAT_PUSH_MAX_COUNT);
  const locales = await bulkGetUserLocales(sb, [userId]).catch(() => new Map<string, string>());
  const body = count > 1
    ? tt('notif.chat_burst.body', locales.get(userId), { count, preview: newest.body })
    : newest.body;
  const tag = chatPushTag(key);
  const payload: NotificationPayload = {
    title: newest.title,
    body,
    tag,
    data: { ...burstPayloadData(newest.data), conversation_key: key, tag },
  } as NotificationPayload;

  // VTID-05718: the admin switch (VTID-04674) applies at send time too, as in notifyUser.
  if (!(await isNotificationTypeAllowed(sb, newest.tenant_id, newest.type, ''))) {
    await markClaimed(sb, claimed, 'suppressed_type_disabled', null);
    return { pushed: 0, suppressed: claimed.length };
  }

  const tally = newPushFanoutOutcome();
  let outcome: PushOutcome;
  try {
    const dispatched = await dispatchPush({
      userId,
      tenantId: newest.tenant_id,
      payload,
      supabase: sb,
      policy: {
        kind: 'deep_link_split',
        hasDeepLink: !!payload.data?.url,
        suppression: 'signed_out_or_lost_device',
        excludeAppilixTaggedOnFallback: true,
      },
      outcome: tally,
      iosBadge: true,
    });
    outcome = classifyPushOutcome(tally, dispatched.appilixSent);
  } catch (err: any) {
    // Give up on this burst rather than retry forever; the in-app rows stay complete.
    console.warn(`[ChatBurst] dispatch failed for user=${userId.slice(0, 8)}… conv=${key}: ${err?.message || err}`);
    outcome = 'dispatch_exception';
  }

  // The newest unread row carries the push (push_sent_at drives the 5-minute window in the coalescer).
  const { error: pushedErr } = await sb
    .from('user_notifications')
    .update({ push_outcome: outcome, push_sent_at: nowIso })
    .eq('id', newest.id);
  if (pushedErr) console.warn(`[ChatBurst] push_outcome write failed for ${newest.id}: ${pushedErr.message}`);
  const others = claimed.filter((r) => r.id !== newest.id);
  await markClaimed(sb, others, 'coalesced', null);
  return { pushed: 1, suppressed: others.length };
}

async function markClaimed(
  sb: Sb,
  rows: BurstRow[],
  outcome: PushOutcome,
  pushSentAt: string | null,
): Promise<void> {
  for (const row of rows) {
    const { error } = await sb
      .from('user_notifications')
      .update({ push_outcome: outcome, ...(pushSentAt ? { push_sent_at: pushSentAt } : {}) })
      .eq('id', row.id)
      .eq('push_outcome', CHAT_BURST_SENDING);
    if (error) console.warn(`[ChatBurst] outcome write failed for ${row.id}: ${error.message}`);
  }
}
