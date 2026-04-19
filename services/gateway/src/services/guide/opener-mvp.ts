/**
 * Proactive Guide — Phase 0.5 Opener MVP
 *
 * Picks ONE candidate for the proactive opener using only data that
 * already exists (life_compass + calendar_events + autopilot_recommendations).
 * No contribution-vector scoring yet — that arrives in Phase 6.
 *
 * Layered selection (highest specificity wins):
 *   1. Overdue autopilot calendar event (start_time < now, status='scheduled')
 *   2. Upcoming autopilot event within 24h
 *   3. Top "new" autopilot recommendation matching active role
 *   4. Wave-aware journey opener (user is in wave N of 90-day journey)
 *   5. Goal-grounded warm opener (user has an active Life Compass goal)
 *
 * Layers 4 and 5 are the FALLBACKS — they ensure that whenever a user has
 * either a journey wave or an active goal, the conversation opens proactively
 * instead of falling back to "what can I do for you?".
 *
 * MUST check isPaused() before returning a candidate.
 */

import { getSupabase } from '../../lib/supabase';
import { isPaused } from './pause-check';
import {
  OpenerCandidate,
  OpenerCandidateKind,
  OpenerSelection,
} from './types';
import { DEFAULT_WAVE_CONFIG } from '../wave-defaults';

const LOG_PREFIX = '[Guide:opener-mvp]';

const JOURNEY_TOTAL_DAYS = 90;

export interface PickOpenerInput {
  user_id: string;
  active_role: 'community' | 'developer' | 'admin';
  channel: 'voice' | 'text';
  /**
   * Phase A (VTID-01927) — when the brain already computed awareness, pass it
   * here to avoid duplicate queries. When omitted, opener-mvp does its own
   * minimal lookups (legacy path).
   */
  awareness?: import('./types').UserAwareness;
}

interface LifeCompassRow {
  id: string;
  primary_goal: string;
  category: string;
}

interface CalendarEventRow {
  id: string;
  title: string;
  start_time: string;
  duration_minutes: number | null;
  event_type: string;
  status: string;
  source_ref: string | null;
}

interface AutopilotRecRow {
  id: string;
  title: string;
  summary: string;
  domain: string;
  role_scope: string;
  status: string;
  user_id: string | null;
  created_at: string;
}

/**
 * Pick the single best opener candidate for this user right now.
 * Honor any active pause silently.
 */
export async function pickOpenerCandidate(input: PickOpenerInput): Promise<OpenerSelection> {
  const supabase = getSupabase();
  if (!supabase) {
    console.warn(`${LOG_PREFIX} no supabase — yielding`);
    return { candidate: null, suppressed_by_pause: false };
  }

  // Active goal (Life Compass) — frames every opener.
  // Auto-seeds the default longevity goal when the user has none, so every
  // user always has a "starting focus" the system can reference. The user
  // can change it any time (the LLM is briefed to honor "change my goals").
  let goal: LifeCompassRow | null = null;
  let goalIsSystemSeeded = false;

  const { data: compassRows } = await supabase
    .from('life_compass')
    .select('id, primary_goal, category')
    .eq('user_id', input.user_id)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);

  if (compassRows && compassRows.length) {
    goal = compassRows[0] as LifeCompassRow;
  } else {
    // Lazy seed — Vitana's default focus is the platform's mission itself:
    // improve quality of life and extend lifespan. The user can swap this
    // for any catalog goal anytime.
    const { data: seeded, error: seedErr } = await supabase
      .from('life_compass')
      .insert({
        user_id: input.user_id,
        primary_goal: 'Improve quality of life and extend lifespan',
        category: 'longevity',
        is_active: true,
        version: 1,
      })
      .select('id, primary_goal, category')
      .single();

    if (seedErr) {
      console.warn(`${LOG_PREFIX} default-goal seed failed for user ${input.user_id}:`, seedErr.message);
    } else if (seeded) {
      goal = seeded as LifeCompassRow;
      goalIsSystemSeeded = true;
      console.log(`${LOG_PREFIX} seeded default longevity goal for user ${input.user_id}`);
    }
  }

  const goalLink = goal
    ? {
        primary_goal: goal.primary_goal,
        category: goal.category,
        is_system_seeded: goalIsSystemSeeded,
      }
    : undefined;

  const nowIso = new Date().toISOString();
  const in24hIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // 1. Overdue autopilot events (highest priority candidate kind)
  const { data: overdueRows } = await supabase
    .from('calendar_events')
    .select('id, title, start_time, duration_minutes, event_type, status, source_ref')
    .eq('user_id', input.user_id)
    .eq('event_type', 'autopilot')
    .eq('status', 'scheduled')
    .lt('start_time', nowIso)
    .order('start_time', { ascending: false })
    .limit(1);

  if (overdueRows && overdueRows.length) {
    const ev = overdueRows[0] as CalendarEventRow;
    const candidate = await buildAndCheck({
      kind: 'overdue_calendar',
      nudge_key: `overdue_event:${ev.id}`,
      title: ev.title,
      subline: ev.duration_minutes ? `${ev.duration_minutes} min — from earlier` : 'from earlier',
      goalLink,
      reason: 'overdue autopilot calendar event from before now',
      category: 'calendar',
      input,
    });
    if (candidate.candidate || candidate.suppressed_by_pause) return candidate;
  }

  // 2. Upcoming within 24h
  const { data: upcomingRows } = await supabase
    .from('calendar_events')
    .select('id, title, start_time, duration_minutes, event_type, status, source_ref')
    .eq('user_id', input.user_id)
    .eq('event_type', 'autopilot')
    .eq('status', 'scheduled')
    .gt('start_time', nowIso)
    .lt('start_time', in24hIso)
    .order('start_time', { ascending: true })
    .limit(1);

  if (upcomingRows && upcomingRows.length) {
    const ev = upcomingRows[0] as CalendarEventRow;
    const startsIn = describeTimeUntil(ev.start_time);
    const candidate = await buildAndCheck({
      kind: 'upcoming_calendar',
      nudge_key: `upcoming_event:${ev.id}`,
      title: ev.title,
      subline: `coming up ${startsIn}${ev.duration_minutes ? ` · ${ev.duration_minutes} min` : ''}`,
      goalLink,
      reason: 'autopilot event scheduled within next 24h',
      category: 'calendar',
      input,
    });
    if (candidate.candidate || candidate.suppressed_by_pause) return candidate;
  }

  // 3. Top "new" autopilot recommendation matching role
  const { data: recRows } = await supabase
    .from('autopilot_recommendations')
    .select('id, title, summary, domain, role_scope, status, user_id, created_at')
    .eq('user_id', input.user_id)
    .eq('status', 'new')
    .in('role_scope', ['any', input.active_role])
    .order('created_at', { ascending: false })
    .limit(1);

  if (recRows && recRows.length) {
    const rec = recRows[0] as AutopilotRecRow;
    const candidate = await buildAndCheck({
      kind: 'autopilot_recommendation',
      nudge_key: `recommendation:${rec.id}`,
      title: rec.title,
      subline: rec.summary?.slice(0, 80),
      goalLink,
      reason: `top new autopilot recommendation in domain "${rec.domain}"`,
      category: rec.domain,
      input,
    });
    if (candidate.candidate || candidate.suppressed_by_pause) return candidate;
  }

  // 4. Fallback — wave-aware journey opener.
  //    Reads the user's registration date from app_users to compute current
  //    journey day, then picks the active wave from DEFAULT_WAVE_CONFIG.
  //    Date-stamped nudge_key so daily dismissals don't permanently silence.
  const dateKey = new Date().toISOString().slice(0, 10);
  let registeredAt: string | null = null;
  const { data: userRows } = await supabase
    .from('app_users')
    .select('created_at')
    .eq('id', input.user_id)
    .limit(1);
  if (userRows && userRows.length) {
    registeredAt = (userRows[0] as { created_at: string }).created_at;
  }

  if (registeredAt) {
    const dayNumber = daysSince(registeredAt);
    const wave = currentWaveForDay(dayNumber);
    if (wave) {
      const candidate = await buildAndCheck({
        kind: 'wave_transition',
        nudge_key: `wave:${wave.id}:${dateKey}`,
        title: `Day ${dayNumber} — ${wave.name}`,
        subline: wave.description,
        goalLink,
        reason: `user is on day ${dayNumber} of the 90-day journey, currently in ${wave.name} wave`,
        category: 'journey',
        input,
      });
      if (candidate.candidate || candidate.suppressed_by_pause) return candidate;
    }
  }

  // 5. Fallback — goal-grounded warm opener.
  //    Always fires when a Life Compass goal is set. Date-stamped nudge_key
  //    so the user gets a fresh opportunity each day even if they dismissed
  //    yesterday's goal nudge.
  if (goal && goalLink) {
    const candidate = await buildAndCheck({
      kind: 'goal_reminder',
      nudge_key: `goal:${goal.id}:${dateKey}`,
      title: `Toward your goal: ${goalLink.primary_goal}`,
      subline: 'open the conversation by inviting reflection on this goal',
      goalLink,
      reason: 'user has an active Life Compass goal but no specific scheduled item — open warmly with the goal as the frame',
      category: 'goal',
      input,
    });
    if (candidate.candidate || candidate.suppressed_by_pause) return candidate;
  }

  console.log(`${LOG_PREFIX} no candidate available for user ${input.user_id}${goal ? '' : ' (no Life Compass goal set)'}`);
  return { candidate: null, suppressed_by_pause: false };
}

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/**
 * Find the wave whose timeline brackets the given day. Prefers earliest
 * end_day so a user with overlapping waves gets the more time-sensitive one.
 * Returns null when day is past the 90-day journey or no wave is enabled.
 */
function currentWaveForDay(day: number): { id: string; name: string; description: string } | null {
  if (day < 0) return null;
  // For users past the journey (day >= 90), don't surface a wave opener —
  // let the goal_reminder fallback handle them. The journey is a 90-day
  // package; beyond that, the proactive system relies on goals + signals.
  if (day >= JOURNEY_TOTAL_DAYS) return null;

  const enabled = DEFAULT_WAVE_CONFIG.filter((w) => w.enabled);
  const matching = enabled.filter(
    (w) => day >= w.timeline.start_day && day <= w.timeline.end_day,
  );
  if (matching.length === 0) return null;

  matching.sort((a, b) => a.timeline.end_day - b.timeline.end_day);
  const w = matching[0];
  return { id: w.id, name: w.name, description: w.description };
}

interface BuildAndCheckInput {
  kind: OpenerCandidateKind;
  nudge_key: string;
  title: string;
  subline?: string;
  goalLink?: { primary_goal: string; category: string };
  reason: string;
  category: string;
  input: PickOpenerInput;
}

/**
 * Build a candidate and check pause + nudge_state silencing in one shot.
 * Returns suppression info when blocked.
 */
async function buildAndCheck(b: BuildAndCheckInput): Promise<OpenerSelection> {
  const candidate: OpenerCandidate = {
    nudge_key: b.nudge_key,
    kind: b.kind,
    title: b.title,
    subline: b.subline,
    goal_link: b.goalLink,
    reason: b.reason,
    category: b.category,
  };

  const pause = await isPaused({
    user_id: b.input.user_id,
    channel: b.input.channel,
    category: b.category,
    nudge_key: b.nudge_key,
  });
  if (pause.paused) {
    return { candidate: null, suppressed_by_pause: true, suppressing_pause: pause.pause };
  }

  const supabase = getSupabase();
  if (supabase) {
    const { data: nudgeRows } = await supabase
      .from('user_nudge_state')
      .select('silenced_until')
      .eq('user_id', b.input.user_id)
      .eq('nudge_key', b.nudge_key)
      .limit(1);
    if (nudgeRows && nudgeRows.length && nudgeRows[0].silenced_until) {
      const silenced = new Date(nudgeRows[0].silenced_until).getTime();
      if (silenced > Date.now()) {
        return { candidate: null, suppressed_by_pause: false };
      }
    }
  }

  return { candidate, suppressed_by_pause: false };
}

function describeTimeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}
