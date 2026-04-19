/**
 * Proactive Guide — Phase 0.5 Opener MVP
 *
 * Picks ONE candidate for the proactive opener using only data that
 * already exists (life_compass + calendar_events + autopilot_recommendations).
 * No contribution-vector scoring yet — that arrives in Phase 6.
 *
 * Heuristic (until Phase 6 swaps in real scoring):
 *   1. Overdue autopilot calendar event (start_time < now, status='scheduled')
 *   2. Upcoming autopilot event within 24h
 *   3. Top "new" autopilot recommendation matching active role
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

const LOG_PREFIX = '[Guide:opener-mvp]';

export interface PickOpenerInput {
  user_id: string;
  active_role: 'community' | 'developer' | 'admin';
  channel: 'voice' | 'text';
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

  // Active goal (Life Compass) — frames every opener
  const { data: compassRows } = await supabase
    .from('life_compass')
    .select('id, primary_goal, category')
    .eq('user_id', input.user_id)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);

  const goal: LifeCompassRow | null = compassRows && compassRows.length ? (compassRows[0] as LifeCompassRow) : null;
  const goalLink = goal ? { primary_goal: goal.primary_goal, category: goal.category } : undefined;

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

  console.log(`${LOG_PREFIX} no candidate available for user ${input.user_id}`);
  return { candidate: null, suppressed_by_pause: false };
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
