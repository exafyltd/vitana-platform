/**
 * VTID-05100 — delivers ONE claimed Vitana Companion Message (mode staff|live).
 *
 *   1. insert the Vitana DM into chat_messages (sender = Vitana bot). The
 *      text is Vitana's composed note; the card is stored as
 *      metadata.card = { kind: 'vitana_card', v: 1, card_type, params }
 *      (chat_messages has no content_data column: the client reads
 *      metadata as content_data, same as calendar invites and DM actions).
 *      params carry only the live numbers from the moment's facts — never a
 *      string: the card's title, text and button come from the Unified Card
 *      System catalog on the client, in the member's current language.
 *   2. record the presence-pacer touch (surface messenger_companion).
 *   3. exactly ONE push via notifyUser('vitana_companion_message'), title and
 *      body from the tt() catalog in the member's locale (§13b). Quiet hours,
 *      the admin switch and the member's chat category apply there; a held
 *      push never undoes the DM (it is the inbox, not an interruption).
 *   4. finish_companion_message('sent', text, model, chat_message_id).
 *
 * A failed DM insert finishes the slot as 'failed' and sends no push.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { VITANA_BOT_USER_ID } from '../../lib/vitana-bot';
import { tt } from '../../i18n/catalog';
import { getUserLocale } from '../../i18n/server-locale';
import { notifyUser } from '../notification-service';
import { recordTouch } from '../guide/presence-pacer';
import { emitOasisEvent } from '../oasis-event-service';
import * as repo from './companion-repository';

export const DELIVERY_VTID = 'VTID-05100';
export const COMPANION_NOTIFICATION_TYPE = 'vitana_companion_message';
export const COMPANION_PACER_SURFACE = 'messenger_companion' as const;
export const COMPANION_DM_URL = `/inbox/u/${VITANA_BOT_USER_ID}`;

export interface DeliveryInput {
  ledgerId: number;
  mode: 'staff' | 'live';
  userId: string;
  tenantId: string;
  momentKey: string;
  cardType: string | null;
  facts: Record<string, unknown>;
  text: string;
  model: string;
}

export interface DeliveryDeps {
  sb: SupabaseClient;
  notify?: typeof notifyUser;
  touch?: typeof recordTouch;
  locale?: (sb: SupabaseClient, userId: string) => Promise<string>;
  emit?: typeof emitOasisEvent;
}

export type DeliveryResult =
  | { ok: true; chatMessageId: string | null; pushed: boolean; pushSuppressed?: string }
  | { ok: false; error: string };

/** Only the live numbers from the moment's facts — the card never carries a string. */
export function cardParams(facts: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(facts ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function buildCompanionMetadata(input: Pick<DeliveryInput, 'momentKey' | 'cardType' | 'facts'>): Record<string, unknown> {
  return {
    source: 'companion',
    moment_key: input.momentKey,
    vtid: DELIVERY_VTID,
    ...(input.cardType
      ? { card: { kind: 'vitana_card', v: 1, card_type: input.cardType, params: cardParams(input.facts) } }
      : {}),
  };
}

export async function deliverCompanionMessage(input: DeliveryInput, deps: DeliveryDeps): Promise<DeliveryResult> {
  const { sb } = deps;
  const notify = deps.notify ?? notifyUser;
  const touch = deps.touch ?? recordTouch;
  const locale = deps.locale ?? ((c: SupabaseClient, id: string) => getUserLocale(c, id));
  const emit = deps.emit ?? emitOasisEvent;

  // 1. The DM.
  let inserted: { id: string | null; error: string | null };
  try {
    inserted = await repo.insertCompanionChatMessage(sb, {
      tenant_id: input.tenantId,
      sender_id: VITANA_BOT_USER_ID,
      receiver_id: input.userId,
      content: input.text,
      message_type: 'text',
      metadata: buildCompanionMetadata(input),
    });
  } catch (err: any) {
    inserted = { id: null, error: err?.message ?? String(err) };
  }
  if (inserted.error) {
    await repo.finishMessage(sb, input.ledgerId, 'failed', input.text, input.model).catch(() => undefined);
    await emit({
      vtid: DELIVERY_VTID, type: 'companion.message.failed', source: 'companion-messages', status: 'error',
      message: `companion DM insert failed: ${inserted.error}`,
      payload: { user_id: input.userId, ledger_id: input.ledgerId, mode: input.mode, moment_key: input.momentKey, stage: 'insert' },
      actor_role: 'system', surface: 'system',
    }).catch(() => undefined);
    return { ok: false, error: `insert_failed: ${inserted.error}` };
  }

  // 2. Pacer touch — never blocks the delivery.
  try {
    await touch({
      user_id: input.userId,
      surface: COMPANION_PACER_SURFACE,
      reason_tag: input.momentKey,
      metadata: { ledger_id: input.ledgerId, chat_message_id: inserted.id, vtid: DELIVERY_VTID },
    });
  } catch (err: any) {
    console.warn(`[companion] pacer touch failed for ${input.userId.slice(0, 8)}…: ${err?.message ?? err}`);
  }

  // 3. Exactly one push.
  let pushed = false;
  let pushSuppressed: string | undefined;
  try {
    const lc = await locale(sb, input.userId);
    const r = await notify(input.userId, input.tenantId, COMPANION_NOTIFICATION_TYPE, {
      title: tt('notif.vitana_companion_message.title', lc),
      body: tt('notif.vitana_companion_message.body', lc),
      data: {
        type: COMPANION_NOTIFICATION_TYPE,
        url: COMPANION_DM_URL,
        sender_id: VITANA_BOT_USER_ID,
        moment_key: input.momentKey,
        ...(inserted.id ? { chat_message_id: inserted.id } : {}),
      },
    }, sb);
    pushed = !!r && (r.pushed > 0 || r.inapp);
    pushSuppressed = r?.suppressed;
  } catch (err: any) {
    console.warn(`[companion] push failed for ${input.userId.slice(0, 8)}… (DM delivered): ${err?.message ?? err}`);
  }

  // 4. The slot is used.
  const fin = await repo.finishMessage(sb, input.ledgerId, 'sent', input.text, input.model, inserted.id)
    .catch((err: any) => ({ ok: false, error: err?.message ?? String(err) }));
  if (!fin.ok) console.warn(`[companion] finish(sent) failed for ledger ${input.ledgerId}: ${fin.error}`);

  await emit({
    vtid: DELIVERY_VTID, type: 'companion.message.sent', source: 'companion-messages', status: 'success',
    message: `companion message sent (${input.mode}, ${input.momentKey})`,
    payload: {
      user_id: input.userId, ledger_id: input.ledgerId, mode: input.mode, moment_key: input.momentKey,
      card_type: input.cardType, chat_message_id: inserted.id, pushed, ...(pushSuppressed ? { push_suppressed: pushSuppressed } : {}),
    },
    actor_role: 'system', surface: 'system',
  }).catch(() => undefined);

  return { ok: true, chatMessageId: inserted.id, pushed, ...(pushSuppressed ? { pushSuppressed } : {}) };
}
