/**
 * Heartbeat Loop - Autonomous task scheduler for Vitana Autopilot.
 *
 * Runs on a configurable interval (default 15min) and performs:
 * - Stripe payment failure detection and retry
 * - Upcoming Daily.co room reminders
 * - Pending health report summarization
 * - General tenant health checks
 *
 * Respects governance gates - stops executing when EXECUTION_DISARMED.
 */

import { checkGovernance, emitOasisEvent } from './oasis-bridge';
import { executeSkillAction } from '../skills';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HeartbeatResult {
  run_id: string;
  started_at: string;
  completed_at: string;
  tasks_checked: number;
  actions_taken: number;
  errors: string[];
  governance_blocked: boolean;
}

// ---------------------------------------------------------------------------
// Heartbeat Tasks
// ---------------------------------------------------------------------------

async function checkStripeFailures(): Promise<{ checked: number; retried: number; errors: string[] }> {
  const errors: string[] = [];
  let retried = 0;

  try {
    const result = (await executeSkillAction('vitana-stripe', 'check_payment_failures', {})) as {
      failures: Array<{ id: string; tenant_id: string }>;
      count: number;
    };

    for (const failure of result.failures ?? []) {
      try {
        await executeSkillAction('vitana-stripe', 'retry_payment', {
          tenant_id: failure.tenant_id,
          subscription_id: failure.id,
        });
        retried++;
      } catch (err) {
        errors.push(`Retry failed for ${failure.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { checked: result.count, retried, errors };
  } catch (err) {
    return { checked: 0, retried: 0, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

async function checkUpcomingRooms(): Promise<{ checked: number; reminders_sent: number; errors: string[] }> {
  const errors: string[] = [];
  let remindersSent = 0;

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE!,
    );

    // Get all tenants with upcoming rooms in the next hour
    const cutoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const reminderWindow = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const { data: rooms } = await supabase
      .from('live_rooms')
      .select('id, tenant_id, scheduled_at')
      .gte('scheduled_at', new Date().toISOString())
      .lte('scheduled_at', cutoff)
      .eq('status', 'scheduled');

    for (const room of rooms ?? []) {
      // Send reminder if room is within 15 minutes
      if (new Date(room.scheduled_at) <= new Date(reminderWindow)) {
        try {
          await executeSkillAction('vitana-daily', 'send_reminder', {
            tenant_id: room.tenant_id,
            room_id: room.id,
            minutes_before: 15,
          });
          remindersSent++;
        } catch (err) {
          errors.push(`Reminder failed for room ${room.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return { checked: rooms?.length ?? 0, reminders_sent: remindersSent, errors };
  } catch (err) {
    return { checked: 0, reminders_sent: 0, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

async function checkPendingReports(): Promise<{ checked: number; summarized: number; errors: string[] }> {
  const errors: string[] = [];
  let summarized = 0;

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE!,
    );

    const { data: reports } = await supabase
      .from('health_reports')
      .select('id, tenant_id')
      .eq('status', 'pending_summary')
      .limit(10);

    for (const report of reports ?? []) {
      try {
        await executeSkillAction('vitana-health', 'summarize_report', {
          tenant_id: report.tenant_id,
          report_id: report.id,
        });
        summarized++;

        // Mark as summarized
        await supabase
          .from('health_reports')
          .update({ status: 'summarized', updated_at: new Date().toISOString() })
          .eq('id', report.id);
      } catch (err) {
        errors.push(`Summary failed for report ${report.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { checked: reports?.length ?? 0, summarized, errors };
  } catch (err) {
    return { checked: 0, summarized: 0, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

// ---------------------------------------------------------------------------
// Main Heartbeat
// ---------------------------------------------------------------------------

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Run a single heartbeat cycle.
 */
export async function runHeartbeat(): Promise<HeartbeatResult> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const allErrors: string[] = [];
  let tasksChecked = 0;
  let actionsTaken = 0;

  // Check governance first
  const governance = await checkGovernance();
  if (!governance.allowed) {
    await emitOasisEvent({
      type: 'openclaw.heartbeat_skipped',
      payload: { run_id: runId, reason: governance.reason },
    });

    return {
      run_id: runId,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      tasks_checked: 0,
      actions_taken: 0,
      errors: [],
      governance_blocked: true,
    };
  }

  await emitOasisEvent({
    type: 'openclaw.heartbeat_started',
    payload: { run_id: runId },
  });

  // 1. Check Stripe failures
  const stripe = await checkStripeFailures();
  tasksChecked += stripe.checked;
  actionsTaken += stripe.retried;
  allErrors.push(...stripe.errors);

  // 2. Check upcoming rooms
  const rooms = await checkUpcomingRooms();
  tasksChecked += rooms.checked;
  actionsTaken += rooms.reminders_sent;
  allErrors.push(...rooms.errors);

  // 3. Check pending health reports
  const reports = await checkPendingReports();
  tasksChecked += reports.checked;
  actionsTaken += reports.summarized;
  allErrors.push(...reports.errors);

  const result: HeartbeatResult = {
    run_id: runId,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    tasks_checked: tasksChecked,
    actions_taken: actionsTaken,
    errors: allErrors,
    governance_blocked: false,
  };

  await emitOasisEvent({
    type: 'openclaw.heartbeat_completed',
    payload: {
      run_id: runId,
      tasks_checked: tasksChecked,
      actions_taken: actionsTaken,
      error_count: allErrors.length,
    },
  });

  return result;
}

/**
 * Start the heartbeat loop at the given interval.
 */
export function startHeartbeat(intervalMs: number): void {
  if (heartbeatTimer) {
    console.warn('[heartbeat] Already running - stopping previous instance');
    stopHeartbeat();
  }

  console.log(`[heartbeat] Starting with interval ${intervalMs}ms (${intervalMs / 60000}min)`);

  // Run immediately, then on interval
  runHeartbeat().catch((err) => {
    console.error('[heartbeat] Initial run failed:', err);
  });

  heartbeatTimer = setInterval(() => {
    runHeartbeat().catch((err) => {
      console.error('[heartbeat] Cycle failed:', err);
    });
  }, intervalMs);
}

/**
 * Stop the heartbeat loop.
 */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log('[heartbeat] Stopped');
  }
}
