/**
 * VTID-04763 — Audiobook daily reminder dispatch.
 *
 * Members who asked for it get one push a day, at a local time they picked:
 * "your episode for today". Only on days they haven't listened yet, never
 * twice a day, and through the same delivery gate as every other reminder
 * (admin switch and member category for `reminder_due`, push switch, quiet
 * hours).
 *
 * Claiming is a single atomic SQL function (claim_due_audiobook_reminders,
 * migration 20261001130000): it selects due members FOR UPDATE SKIP LOCKED
 * and stamps the local date in the same statement, so any number of gateway
 * tasks — staging and production share the database — can tick at once and
 * a member still gets at most one push per day.
 *
 * Runs wherever reminders are dispatched (REMINDERS_INPROCESS_DISPATCH_ENABLED
 * exactly 'true', the existing switch), with its own kill switch
 * AUDIOBOOK_REMINDERS_DISABLED='true'. The text comes from the gateway catalog
 * in the member's language (§13b); the deep link is a plain path because the
 * Android app wrapper drops notification URLs that carry a query string.
 */

import { getUserLocale } from '../../i18n/server-locale';
import { tt } from '../../i18n/catalog';
import { decidePushDelivery } from '../notification-controls/notification-controls-service';
import { sendPushToUser } from '../notification-service';
import { REMINDER_NOTIFICATION_TYPE } from '../reminders-dispatch';

export const AUDIOBOOK_REMINDER_ROUTE = '/autopilot/audiobook';
const TICK_MS = 5 * 60 * 1000;

export interface ClaimedAudiobookReminder {
  user_id: string;
  tenant_id: string | null;
  local_date: string;
}

export interface AudiobookReminderDeps {
  getLocale?: typeof getUserLocale;
  decide?: typeof decidePushDelivery;
  send?: typeof sendPushToUser;
}

/** One tick: claim due reminders and push each. Never throws. */
export async function runAudiobookReminderTick(
  supa: any,
  deps: AudiobookReminderDeps = {},
): Promise<{ ok: boolean; claimed: number; sent: number; error?: string }> {
  const getLocale = deps.getLocale ?? getUserLocale;
  const decide = deps.decide ?? decidePushDelivery;
  const send = deps.send ?? sendPushToUser;

  const { data, error } = await supa.rpc('claim_due_audiobook_reminders', { p_limit: 200 });
  if (error) return { ok: false, claimed: 0, sent: 0, error: error.message };
  const claimed = (data ?? []) as ClaimedAudiobookReminder[];

  let sent = 0;
  for (const row of claimed) {
    try {
      if (!row.tenant_id) {
        console.warn(`[audiobook-reminder] ${row.user_id.slice(0, 8)} has no tenant; skipped`);
        continue;
      }
      const decision = await decide(supa, {
        userId: row.user_id,
        tenantId: row.tenant_id,
        type: REMINDER_NOTIFICATION_TYPE,
        priority: 'p2',
      });
      if (!decision.send) {
        console.log(`[audiobook-reminder] ${row.user_id.slice(0, 8)} not sent: ${decision.reason}`);
        continue;
      }
      const locale = await getLocale(supa, row.user_id);
      const devices = await send(
        row.user_id,
        row.tenant_id,
        {
          title: tt('notif.audiobook_daily.title', locale),
          body: tt('notif.audiobook_daily.body', locale),
          data: { type: 'audiobook.daily', url: AUDIOBOOK_REMINDER_ROUTE },
        },
        supa,
      );
      if (devices > 0) sent += 1;
    } catch (err: any) {
      console.warn(`[audiobook-reminder] push failed for ${row.user_id.slice(0, 8)}: ${err?.message || err}`);
    }
  }
  if (claimed.length) console.log(`[audiobook-reminder] tick claimed=${claimed.length} sent=${sent}`);
  return { ok: true, claimed: claimed.length, sent };
}

let started = false;

export function isAudiobookReminderLoopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REMINDERS_INPROCESS_DISPATCH_ENABLED === 'true' && env.AUDIOBOOK_REMINDERS_DISABLED !== 'true';
}

/** Start the 5-minute tick. Idempotent; returns whether it was started. */
export function startAudiobookReminderLoop(getClient: () => Promise<any> | any): boolean {
  if (started || !isAudiobookReminderLoopEnabled()) return false;
  started = true;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const supa = await getClient();
      if (supa) {
        const r = await runAudiobookReminderTick(supa);
        if (!r.ok) console.warn('[audiobook-reminder] tick error:', r.error);
      }
    } catch (err: any) {
      console.warn('[audiobook-reminder] tick exception:', err?.message || err);
    } finally {
      busy = false;
    }
  }, TICK_MS).unref?.();
  console.log('[audiobook-reminder] daily episode reminder loop started (5 min tick)');
  return true;
}
