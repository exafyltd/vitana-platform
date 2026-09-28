/**
 * Reminder dispatch — VTID-02601 core, extracted by VTID-04320.
 *
 * The tick (claim due rows → mark fired → push) and the sweeper (recover rows
 * stuck in 'dispatching') used to live only inside the POST /reminders-tick
 * and /reminders-sweeper route handlers, which nothing has called since the
 * GCP Cloud Scheduler was shut down (2026-08-16): the EventBridge replacement
 * in scripts/aws/setup-eventbridge-cron-migration.sh was never applied, so on
 * 2026-09-23 five pending reminders sat 1-12 days overdue with
 * dispatch_attempts=0.
 *
 * Both routes still exist and delegate here; startRemindersDispatchLoop()
 * additionally runs the same functions in-process, so reminders fire without
 * depending on any external scheduler. Running on several ECS tasks at once
 * is safe: reminders_claim_due() claims with FOR UPDATE SKIP LOCKED.
 *
 * Stale guard: a pending reminder more than REMINDERS_STALE_AFTER_MINUTES
 * (default 60) past its fire time is closed as status='failed',
 * delivery_via='stale_skipped' instead of being pushed. After an outage a
 * lock-screen alert for something that was due days ago is noise, and the
 * /stream SSE poll has no time bound, so a stale row marked 'fired' would
 * also pop the full-screen interrupt on the web.
 */

import { sendPushToUser, sendAppilixPush, isSignedOutOnAllKnownDevices } from './notification-service';
import { decidePushDelivery } from './notification-controls/notification-controls-service';

/** VTID-04674: the notification type the admin switches reminders with. */
export const REMINDER_NOTIFICATION_TYPE = 'reminder_due';
import { tt } from '../i18n/catalog';
import { getUserLocale } from '../i18n/server-locale';
import * as repo from '../routes/scheduled-notifications-repository';

const DEFAULT_STALE_AFTER_MINUTES = 60;
const DEFAULT_TICK_INTERVAL_MS = 30_000;
const SWEEPER_INTERVAL_MS = 5 * 60_000;

export function resolveStaleAfterMinutes(raw: string | undefined = process.env.REMINDERS_STALE_AFTER_MINUTES): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_AFTER_MINUTES;
}

export function isInProcessDispatchEnabled(raw: string | undefined = process.env.REMINDERS_INPROCESS_DISPATCH_ENABLED): boolean {
  return raw === 'true';
}

async function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

export interface TickResult {
  ok: boolean;
  fired: number;
  failed: number;
  total: number;
  stale_skipped: number;
  error?: string;
}

export async function skipStaleReminders(supa: any, now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - resolveStaleAfterMinutes() * 60_000).toISOString();
  const { data, error } = await repo.closeStalePendingReminders(supa, { cutoff });
  if (error) {
    console.error('[reminders-tick] stale guard failed:', error.message);
    return 0;
  }
  const rows: Array<{ id: string; user_id: string; next_fire_at: string }> = data || [];
  if (rows.length) {
    console.warn(`[reminders-tick] closed ${rows.length} stale reminder(s) older than ${resolveStaleAfterMinutes()} min without pushing`);
    try {
      const { emitOasisEvent } = await import('./oasis-event-service');
      for (const r of rows) {
        await emitOasisEvent({
          type: 'reminder.stale_skipped' as any,
          source: 'gateway',
          vtid: 'VTID-REMINDER',
          status: 'warning',
          message: 'Reminder skipped: too far past its fire time',
          payload: { reminder_id: r.id, user_id: r.user_id, scheduled_for: r.next_fire_at },
        });
      }
    } catch {}
  }
  return rows.length;
}

export async function runRemindersTick(supa: any): Promise<TickResult> {
  const staleSkipped = await skipStaleReminders(supa);

  // Atomic claim + mark dispatching. Look-ahead window: 15s.
  const { data: claimed, error: claimErr } = await repo.rpcClaimDueReminders(supa, {
    lookaheadSeconds: 15,
    limit: 200,
  });

  // RPC may not exist on older DBs — best-effort non-atomic fallback.
  let rows: any[] = [];
  if (claimErr) {
    const lookahead = new Date(Date.now() + 15_000).toISOString();
    const { data: fallback, error: fallbackErr } = await repo.fallbackClaimDueReminders(supa, {
      lookahead,
      dispatchStartedAt: new Date().toISOString(),
      limit: 200,
    });
    if (fallbackErr) {
      console.error('[reminders-tick] claim fallback failed:', fallbackErr.message);
      return { ok: false, fired: 0, failed: 0, total: 0, stale_skipped: staleSkipped, error: fallbackErr.message };
    }
    rows = fallback || [];
  } else {
    rows = claimed || [];
  }

  let fired = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const { error: fireErr } = await repo.markReminderFired(supa, { reminderId: row.id, firedAt: new Date().toISOString() });
      if (fireErr) {
        console.error(`[reminders-tick] mark fired failed for ${row.id}:`, fireErr.message);
        failed++;
        continue;
      }

      try {
        const { emitOasisEvent } = await import('./oasis-event-service');
        await emitOasisEvent({
          type: 'reminder.fired' as any,
          source: 'gateway',
          vtid: 'VTID-REMINDER',
          status: 'info',
          message: `Reminder fired`,
          payload: {
            reminder_id: row.id,
            user_id: row.user_id,
            tenant_id: row.tenant_id,
            scheduled_for: row.next_fire_at,
            latency_ms: Date.now() - new Date(row.next_fire_at).getTime(),
          },
        });
      } catch {}

      // 5s after fire, always send an OS-level push (FCM + Appilix). Detached.
      scheduleReminderFcmPush(supa, row).catch((e) =>
        console.warn(`[reminders-tick] FCM push schedule failed for ${row.id}:`, e?.message),
      );

      fired++;
    } catch (err: any) {
      console.error(`[reminders-tick] error firing ${row.id}:`, err?.message);
      failed++;
    }
  }

  if (rows.length) console.log(`[reminders-tick] fired=${fired} failed=${failed} total=${rows.length}`);
  return { ok: true, fired, failed, total: rows.length, stale_skipped: staleSkipped };
}

export interface SweepResult {
  ok: boolean;
  recovered: number;
  exhausted: number;
  total: number;
  error?: string;
}

export async function runRemindersSweeper(supa: any): Promise<SweepResult> {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: stuck, error: queryErr } = await repo.fetchStuckDispatchingReminders(supa, { cutoff, limit: 500 });
  if (queryErr) return { ok: false, recovered: 0, exhausted: 0, total: 0, error: queryErr.message };
  if (!stuck?.length) return { ok: true, recovered: 0, exhausted: 0, total: 0 };

  let recovered = 0;
  let exhausted = 0;
  for (const r of stuck) {
    const attempts = (r.dispatch_attempts || 0) + 1;
    const newStatus = attempts >= 5 ? 'failed' : 'pending';
    const { error: updErr } = await repo.updateReminderRecoveryStatus(supa, { reminderId: r.id, newStatus, attempts });
    if (updErr) {
      console.error(`[reminders-sweeper] update ${r.id} failed:`, updErr.message);
      continue;
    }
    if (newStatus === 'pending') recovered++;
    else exhausted++;
  }
  console.log(`[reminders-sweeper] recovered=${recovered} exhausted=${exhausted} total=${stuck.length}`);
  return { ok: true, recovered, exhausted, total: stuck.length };
}

let loopStarted = false;

/**
 * Starts the in-process tick (every REMINDERS_TICK_INTERVAL_MS, default 30s)
 * and sweeper (every 5 min). Gated on REMINDERS_INPROCESS_DISPATCH_ENABLED
 * exactly 'true'. Idempotent; each loop skips a cycle while the previous one
 * is still running. Returns whether the loop was started.
 */
export function startRemindersDispatchLoop(): boolean {
  if (loopStarted || !isInProcessDispatchEnabled()) return false;
  loopStarted = true;

  const raw = Number(process.env.REMINDERS_TICK_INTERVAL_MS);
  const tickMs = Number.isFinite(raw) && raw >= 5_000 ? raw : DEFAULT_TICK_INTERVAL_MS;

  let ticking = false;
  const tick = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const supa = await getServiceClient();
      if (supa) {
        const r = await runRemindersTick(supa);
        if (!r.ok) console.warn('[reminders-loop] tick error:', r.error);
      }
    } catch (err: any) {
      console.warn('[reminders-loop] tick exception:', err?.message || err);
    } finally {
      ticking = false;
    }
  }, tickMs);

  let sweeping = false;
  const sweep = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const supa = await getServiceClient();
      if (supa) {
        const r = await runRemindersSweeper(supa);
        if (!r.ok) console.warn('[reminders-loop] sweeper error:', r.error);
      }
    } catch (err: any) {
      console.warn('[reminders-loop] sweeper exception:', err?.message || err);
    } finally {
      sweeping = false;
    }
  }, SWEEPER_INTERVAL_MS);

  tick.unref?.();
  sweep.unref?.();
  return true;
}

// =============================================================================
// VTID-02601 — scheduleReminderFcmPush
//
// 5 seconds after a reminder is marked 'fired', send the mobile/web push
// (FCM + Appilix native). Always fires regardless of SSE ack — product
// decision (BOOTSTRAP-REMINDERS-CRON): a reminder should always reach the
// lock screen even if the user already saw the in-app banner on web, because
// they may dismiss the web banner, walk away, and rely on the phone. The web
// overlay's seen-set dedups so a user with both surfaces open never sees the
// same fire rendered twice.
//
// The 5-second delay stays as a small grace window (lets the SSE banner land
// first when the app is open) and to keep the Cloud Run instance warm. Worst
// case (instance scales to zero) the push is dropped and the next tick poll
// re-picks it via the fired+unacked SSE flow.
//
// Title is localized (CLAUDE.md §13b) so German users don't see English on
// the lock screen; the body is the user's own reminder text (not translated).
// =============================================================================
export async function scheduleReminderFcmPush(
  supa: any,
  row: { id: string; user_id: string; tenant_id: string; action_text: string; spoken_message: string | null }
): Promise<void> {
  await new Promise((r) => setTimeout(r, 5000));

  const locale = await getUserLocale(supa, row.user_id);
  const payload = {
    title: tt('notif.reminder.title', locale),
    body: row.action_text,
    data: {
      type: 'reminder.fire',
      reminder_id: row.id,
      // Deep-link to the reminder action overlay (Mark done / Snooze /
      // Dismiss) rather than the bare list — the frontend opens
      // ReminderInterruptOverlay when the fire id is present, matching the
      // in-app SSE behaviour on a push click. Path-based, not query-string —
      // Appilix's Android in-app browser silently fails to launch
      // notification URLs containing a query string (see App.tsx's
      // BOOTSTRAP-NOTIF-MESSENGER-DIAG comment).
      url: `/reminders/fire/${row.id}`,
      spoken_message: row.spoken_message || '',
    },
  };

  try {
    // VTID-04674: the same rule as every other notification — admin switch
    // for 'reminder_due', the member's category, push switch, quiet hours.
    // The in-app reminder (SSE overlay) is unaffected; only the push is held.
    const decision = await decidePushDelivery(supa, {
      userId: row.user_id,
      tenantId: row.tenant_id,
      type: REMINDER_NOTIFICATION_TYPE,
      priority: 'p1',
    });
    if (!decision.send) {
      console.log(`[reminders-tick] push for ${row.id} not sent: ${decision.reason}`);
      return;
    }

    const fcmSent = await sendPushToUser(row.user_id, row.tenant_id, payload, supa);

    // Avoid double-notifying. Mirrors notifyUser()'s FCM/Appilix coexistence
    // rule: if the user has an Appilix-wrapped native token (device_label
    // 'Appilix %'), FCM-direct already delivered to the installed app, so
    // sending Appilix too would surface a second identical lock-screen
    // notification. Only fire Appilix when there's no native token, or as a
    // last resort when FCM reached zero devices (e.g. web-only token that
    // opens the browser, not the app).
    //
    // VTID-03481: only count devices this user still OWNS, and skip Appilix
    // altogether once they are signed out on every known device — otherwise a
    // reminder for the account that left a shared phone still buzzes it.
    let appilixSent = false;
    const appilixSuppressed = await isSignedOutOnAllKnownDevices(row.user_id, supa);
    const { count: nativeMobileCount } = await repo.countAppilixNativeDeviceTokens(supa, {
      userId: row.user_id,
      tenantId: row.tenant_id,
    });
    if (!nativeMobileCount && !appilixSuppressed) {
      appilixSent = await sendAppilixPush(row.user_id, payload);
    }
    if (fcmSent === 0 && !appilixSent && !appilixSuppressed) {
      appilixSent = await sendAppilixPush(row.user_id, payload);
    }
    console.log(`[reminders-tick] FCM push for ${row.id}: fcm=${fcmSent} appilix=${appilixSent} nativeTokens=${nativeMobileCount || 0}`);

    // Mark delivery_via=fcm if we sent at least one push and the row is still
    // unacked. The SSE flow may still race-deliver later — that's fine, the
    // overlay's seen-set dedups so the user never sees the same fire twice.
    if (fcmSent > 0 || appilixSent) {
      await repo.markReminderDeliveredViaFcm(supa, row.id);
    }

    try {
      const { emitOasisEvent } = await import('./oasis-event-service');
      await emitOasisEvent({
        type: 'reminder.fcm_fallback' as any,
        source: 'gateway',
        vtid: 'VTID-REMINDER',
        status: 'info',
        message: `Reminder FCM fallback sent`,
        payload: {
          reminder_id: row.id,
          user_id: row.user_id,
          fcm_devices: fcmSent,
          appilix_sent: !!appilixSent,
        },
      });
    } catch {}
  } catch (err: any) {
    console.error(`[reminders-tick] FCM fallback error for ${row.id}:`, err?.message);
  }
}
