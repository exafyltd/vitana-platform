/**
 * Companion Phase H.3 — Morning Brief scheduler (VTID-01949)
 *
 * Runs hourly. At the configured morning hour (UTC by default,
 * overridable per env), enumerates active users and dispatches
 * at most one morning_briefing_ready push to each — gated by the
 * pacer, notification prefs, and DND. Idempotent within a calendar day.
 *
 * Minimal by design: no per-user timezone logic in v1. Operators can
 * set DEFAULT_MORNING_BRIEF_HOUR_UTC (0-23) to match the primary
 * cohort's local morning. Phase H.3.2 will layer per-user tz.
 */

import { getSupabase } from '../../lib/supabase';
import { notifyUser } from '../notification-service';
import { buildMorningBrief } from './morning-brief-generator';
import { recordTouch } from './presence-pacer';

const LOG_PREFIX = '[VTID-01949:MorningBrief]';

// How often the scheduler wakes up to look for due users. 15min gives decent
// spread (a user who was inactive at the top of the hour gets picked up next tick).
const TICK_MS = 15 * 60 * 1000;

// Default dispatch hour (UTC). Configurable via env.
const DEFAULT_HOUR_UTC = Number(process.env.DEFAULT_MORNING_BRIEF_HOUR_UTC ?? '8');

// How many users to process per tick (safety cap)
const MAX_USERS_PER_TICK = Number(process.env.MORNING_BRIEF_BATCH_CAP ?? '500');

interface SchedulerState {
  timerId?: NodeJS.Timeout;
  isRunning: boolean;
  lastTickAt?: Date;
}

const state: SchedulerState = { isRunning: false };

export function startMorningBriefScheduler(): void {
  if (state.isRunning) {
    console.log(`${LOG_PREFIX} already running`);
    return;
  }

  const enabled = (process.env.MORNING_BRIEF_ENABLED ?? 'false').toLowerCase() === 'true';
  if (!enabled) {
    console.log(`${LOG_PREFIX} disabled (MORNING_BRIEF_ENABLED != "true")`);
    return;
  }

  state.isRunning = true;
  console.log(
    `${LOG_PREFIX} started — dispatch hour=${DEFAULT_HOUR_UTC} UTC, tick=${TICK_MS / 60000}min`
  );

  const tick = async () => {
    try {
      await runTick();
    } catch (err: any) {
      console.error(`${LOG_PREFIX} tick error:`, err?.message || err);
    } finally {
      state.lastTickAt = new Date();
    }
  };

  // Fire once immediately in case the service (re)starts at the target hour
  tick();
  state.timerId = setInterval(tick, TICK_MS);
}

export function stopMorningBriefScheduler(): void {
  if (!state.isRunning) return;
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = undefined;
  state.isRunning = false;
  console.log(`${LOG_PREFIX} stopped`);
}

async function runTick(): Promise<void> {
  const now = new Date();
  const currentHourUtc = now.getUTCHours();
  if (currentHourUtc !== DEFAULT_HOUR_UTC) {
    // Not the dispatch window
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    console.warn(`${LOG_PREFIX} supabase unavailable — skipping tick`);
    return;
  }
  const todayIso = now.toISOString().slice(0, 10);

  // Candidate users: active in the last 30 days (we don't want to ping churned users)
  // AND do not already have a morning_brief touch logged for today.
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: candidates, error: candErr } = await supabase
    .from('oasis_events')
    .select('metadata')
    .eq('topic', 'orb.session.started')
    .gte('created_at', since)
    .limit(10000);

  if (candErr) {
    console.warn(`${LOG_PREFIX} candidate query failed:`, candErr.message);
    return;
  }

  const userIds = new Set<string>();
  for (const row of candidates || []) {
    const uid = (row.metadata as any)?.user_id;
    if (uid) userIds.add(uid);
    if (userIds.size >= MAX_USERS_PER_TICK) break;
  }

  if (userIds.size === 0) {
    console.log(`${LOG_PREFIX} no candidate users`);
    return;
  }

  // Filter out users who already got a morning_brief today
  const { data: alreadySent } = await supabase
    .from('user_proactive_touches')
    .select('user_id')
    .eq('surface', 'morning_brief')
    .gte('sent_at', `${todayIso}T00:00:00Z`);

  const sentSet = new Set<string>((alreadySent || []).map((r: any) => r.user_id));
  const todo = Array.from(userIds).filter((id) => !sentSet.has(id));
  if (todo.length === 0) {
    console.log(`${LOG_PREFIX} all eligible users already received today`);
    return;
  }

  console.log(`${LOG_PREFIX} dispatching to ${todo.length} user(s)`);

  // Look up user_name + tenant_id in a single query
  const { data: users } = await supabase
    .from('app_users')
    .select('user_id, tenant_id, display_name')
    .in('user_id', todo);

  let sent = 0;
  let skipped = 0;

  for (const u of users || []) {
    try {
      const brief = await buildMorningBrief({
        user_id: u.user_id,
        tenant_id: u.tenant_id,
        user_name: u.display_name,
        now,
      });
      if (!brief) {
        skipped++;
        continue;
      }

      // Dispatch via notification-service (respects user prefs + DND)
      const result = await notifyUser(
        u.user_id,
        u.tenant_id,
        'morning_briefing_ready',
        brief,
        supabase
      );

      if (result.suppressed) {
        skipped++;
        continue;
      }

      // Log the touch so the pacer can count it + dedupe future ticks
      await recordTouch({
        user_id: u.user_id,
        surface: 'morning_brief',
        reason_tag: brief.reason_tag,
        metadata: {
          variant: brief.variant,
          bucket: brief.bucket,
          title: brief.title,
        },
      });
      sent++;
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} user ${u.user_id} failed:`, err?.message);
    }
  }

  console.log(`${LOG_PREFIX} tick complete — sent=${sent} skipped=${skipped}`);
}

export function getMorningBriefSchedulerStatus() {
  return {
    isRunning: state.isRunning,
    lastTickAt: state.lastTickAt?.toISOString(),
    targetHourUtc: DEFAULT_HOUR_UTC,
    enabled: (process.env.MORNING_BRIEF_ENABLED ?? 'false').toLowerCase() === 'true',
  };
}
