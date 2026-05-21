/**
 * VTID-03107 · Gateway worker: trial lifecycle notifications.
 *
 * Polls lifecycle_notification_state for rows fired in the last 2 hours
 * whose notified_at is NULL, fans out via notifyUserAsync, marks notified_at.
 *
 * The SQL processor (fn_process_lifecycle_notifications, hourly pg_cron)
 * does the milestone detection + idempotency PK; this worker only does
 * the notification dispatch.
 *
 * i18n bodies for each kind live inline below as English placeholders. A
 * follow-up will move them to src/i18n/ shards via the existing gateway
 * server-side i18n catalog (services/gateway/src/i18n/catalog.ts) per the
 * PR-#2269 server-side i18n hard rule. For v1 launch the English shape is
 * what ops can preview; localized strings are a fast follow.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase';
import { notifyUserAsync } from './notification-service';

const VTID = 'VTID-03107';
const LOG_PREFIX = '[lifecycle-notification-worker]';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOOK_BACK_HOURS = 2;

interface LifecycleStateRow {
  user_id: string;
  tenant_id: string;
  lifecycle_kind: string;
  subscription_id: string | null;
  metadata: Record<string, unknown> | null;
  fired_at: string;
}

/**
 * Inline copy per lifecycle kind. Placeholder English; i18n is a follow-up.
 * Each entry is the notification body the user sees on lock screen + in-app.
 * Keys not present here = unknown kind, worker logs warn + marks row processed.
 */
const COPY: Record<string, { title: string; body: string }> = {
  trial_welcome: {
    title: 'Welcome to Premium',
    body: 'Your free trial has started. Take a look around — your full access is active.',
  },
  trial_midpoint: {
    title: "You're halfway through your trial",
    body: 'A week of Premium gone — keep going at €9.99/mo or stay on Free with the limits.',
  },
  trial_ending_2d: {
    title: 'Your trial ends in 2 days',
    body: "Want to keep what you've been using? Add a payment method anytime.",
  },
  trial_ending_1d: {
    title: 'Your trial ends tomorrow',
    body: 'Add a payment method to keep Premium, or stay on Free with the limits.',
  },
  trial_cancelled_winback: {
    title: 'Your memory garden and streak stay',
    body: 'Premium is no longer active. Come back anytime — your data is waiting.',
  },
  trial_winback_one_shot: {
    title: 'Your community is still here',
    body: 'Want to give Premium another week, on us? Tap to see what changed.',
  },
  founding_midpoint: {
    title: "You're halfway through your Founding Member period",
    body: '45 days of Premium gone, 45 to go. Enjoy.',
  },
  founding_ending_2d: {
    title: 'Founding Member period ends in 2 days',
    body: 'Want to keep Premium past day 90? Add a payment method anytime.',
  },
  founding_ending_1d: {
    title: 'Founding Member period ends tomorrow',
    body: 'Add a payment method to keep Premium, or stay on Free with the limits.',
  },
};

let pollerHandle: NodeJS.Timeout | null = null;
let inFlight = false;

async function processBatch(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const sb = getSupabase();
    if (!sb) {
      console.warn(`${LOG_PREFIX} Supabase unavailable — skipping cycle`);
      return;
    }

    const sinceIso = new Date(Date.now() - LOOK_BACK_HOURS * 3600_000).toISOString();
    const { data, error } = await sb
      .from('lifecycle_notification_state')
      .select('user_id, tenant_id, lifecycle_kind, subscription_id, metadata, fired_at')
      .gte('fired_at', sinceIso)
      .is('notified_at', null)
      .limit(500);

    if (error) {
      if (/notified_at/i.test(error.message) || /column .* does not exist/i.test(error.message)) {
        // Migration not applied — soft-fail until ops applies it.
        return;
      }
      console.warn(`${LOG_PREFIX} query failed: ${error.message}`);
      return;
    }

    const rows = (data || []) as LifecycleStateRow[];
    if (!rows.length) return;
    console.log(`${LOG_PREFIX} processing ${rows.length} lifecycle event(s)`);

    for (const row of rows) {
      const copy = COPY[row.lifecycle_kind];
      if (!copy) {
        console.warn(`${LOG_PREFIX} unknown lifecycle_kind: ${row.lifecycle_kind}`);
      } else {
        try {
          notifyUserAsync(
            row.user_id,
            row.tenant_id,
            row.lifecycle_kind,
            {
              title: copy.title,
              body: copy.body,
              data: {
                lifecycle_kind: row.lifecycle_kind,
                vtid: VTID,
              },
            },
            sb as SupabaseClient<any, any, any>,
          );
        } catch (err) {
          console.warn(
            `${LOG_PREFIX} notifyUserAsync failed for ${row.user_id} ${row.lifecycle_kind}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      const { error: updErr } = await sb
        .from('lifecycle_notification_state')
        .update({ notified_at: new Date().toISOString() })
        .eq('user_id', row.user_id)
        .eq('lifecycle_kind', row.lifecycle_kind);
      if (updErr) {
        console.warn(
          `${LOG_PREFIX} mark-notified failed for ${row.user_id} ${row.lifecycle_kind}: ${updErr.message}`
        );
      }
    }
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} unexpected error: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    inFlight = false;
  }
}

export function startLifecycleNotificationWorker(): void {
  if (pollerHandle) return;
  console.log(`${LOG_PREFIX} starting (poll interval ${POLL_INTERVAL_MS}ms)`);
  processBatch().catch(() => {});
  pollerHandle = setInterval(() => {
    processBatch().catch(() => {});
  }, POLL_INTERVAL_MS);
}

export function stopLifecycleNotificationWorker(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
}

export const _VTID = VTID;
