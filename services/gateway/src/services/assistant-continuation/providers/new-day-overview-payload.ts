/**
 * VTID-03172 — Unified new-day overview payload aggregator.
 *
 * Replaces the VTID-03167 standalone aggregator with one that READS THE
 * SAME DATA the My Journey screen renders. Voice + screen now share the
 * exact same per-signal source functions:
 *
 *   - Journey state        →  getJourneyState (services/journey/user-journey-service)
 *                             [same path used by GET /api/v1/my-journey]
 *   - Life Compass         →  fetchLifeCompass (services/user-context-profiler)
 *                             [same path used by GET /api/v1/my-journey]
 *   - Vitana Index         →  fetchVitanaIndexForProfiler (snapshot)
 *                             [same path used by GET /api/v1/my-journey + the
 *                              trajectory card on AutopilotDashboard]
 *   - Autopilot recs       →  direct query on autopilot_recommendations
 *                             [same table the screen renders, bucketed for voice]
 *
 * Voice keeps its time-sensitive signals that the screen doesn't render:
 * calendar today + passed, messages unread, matches unread, reminders
 * today, diary 7-day streak.
 *
 * Per-signal SETUP STATE is exposed (`state: 'set'|'not_set'` style) so
 * the prompt can switch between three branches for each signal:
 *   1. has data            → speak it (Rule 3: numbers + meaning + pillar)
 *   2. empty for today     → silent (it's not a gap, just nothing scheduled)
 *   3. user hasn't set up  → invitation ("magst du, dass wir das gleich
 *                            gemeinsam machen?")
 *
 * The prompt layer renders. This aggregator only assembles.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getJourneyState, type JourneyState } from '../../journey/user-journey-service';
import { fetchLifeCompass, fetchVitanaIndexForProfiler } from '../../user-context-profiler';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export type SignalSetupState = 'set' | 'not_set';

export interface OverviewPayload {
  // -- JOURNEY (same source as /api/v1/my-journey) --
  journey: {
    day_in_journey: number;
    total_days: number;
    days_left: number;
    is_first_session: boolean;
    plan_type: 'default' | 'personalized';
    current_wave: {
      name: string;
      description: string;
      day_in_wave: number;
      days_to_next_wave: number | null;
    } | null;
  } | null;

  // -- VITANA INDEX (same source as /api/v1/my-journey + AutopilotDashboard NowCard) --
  vitana_index: {
    state: 'ok' | 'not_set_up' | 'baseline_no_score';
    today: number | null;
    tier: string | null;
    tier_framing: string | null;
    trend_7d: number | null;            // delta over last 7 days; can be < 0
    weakest_pillar: { name: string; score: number } | null;
    strongest_pillar: { name: string; score: number } | null;
    balance_label: string | null;
    pillars: { sleep: number; nutrition: number; exercise: number; hydration: number; mental: number } | null;
    projected_day_90: number | null;
    projected_day_90_tier: string | null;
  };

  // -- LIFE COMPASS (same source as /api/v1/my-journey + CompassCard) --
  life_compass: {
    state: SignalSetupState;
    primary_goal: string | null;
    category: string | null;
    target_date: string | null;
    target_value: number | null;
    target_unit: string | null;
    starting_value: number | null;
    set_at: string | null;
    days_to_deadline: number | null;
    goal_progress_pct: number | null;   // time-based progress, 0-100
  };

  // -- CALENDAR (voice-only signal, time-sensitive) --
  calendar_today: { count: number; next: { title: string; start_iso: string } | null };
  calendar_passed: { count: number; most_recent: { title: string; start_iso: string } | null };

  // -- AUTOPILOT (same table as AutopilotDashboard, bucketed for voice) --
  autopilot: {
    state: 'has_actions' | 'none_yet';
    today_checkpoint: {
      recommendation_id: string;
      title: string;
      summary: string | null;
      domain: string | null;
      impact_score: number | null;
    } | null;
    this_week: Array<{
      recommendation_id: string;
      title: string;
      summary: string | null;
    }>;
    pending_total: number;
  };

  // -- MATCHES (voice-only) --
  matches_unread: number;

  // -- MESSAGES (voice-only) --
  messages_unread: number;

  // -- REMINDERS (voice-only) --
  reminders_today: { count: number; next: { action_text: string; next_fire_at: string } | null };

  // -- DIARY (voice-only, streak proxy) --
  diary_last_7d: number;

  // -- META --
  last_session_date_user_tz: string | null;
}

export interface AggregateArgs {
  supabase: SupabaseClient;
  userId: string;
  timezone: string;
  now: Date;
  lastSessionDateUserTz: string | null;
}

// ---------------------------------------------------------------------------
// TZ helpers (unchanged)
// ---------------------------------------------------------------------------

function dayWindowUtcIso(now: Date, timezone: string): { startUtc: string; endUtc: string } {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const parts = fmt.formatToParts(now).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    const Y = parseInt(parts.year, 10);
    const M = parseInt(parts.month, 10) - 1;
    const D = parseInt(parts.day, 10);
    const lh = parseInt(parts.hour ?? '0', 10);
    const lm = parseInt(parts.minute ?? '0', 10);
    const ls = parseInt(parts.second ?? '0', 10);
    const localAsUtcMs = Date.UTC(Y, M, D, lh, lm, ls);
    const offsetMs = now.getTime() - localAsUtcMs;
    const localMidnightUtcMs = Date.UTC(Y, M, D, 0, 0, 0) + offsetMs;
    return {
      startUtc: new Date(localMidnightUtcMs).toISOString(),
      endUtc: new Date(localMidnightUtcMs + 24 * 3600 * 1000 - 1).toISOString(),
    };
  } catch {
    const utcMid = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return {
      startUtc: utcMid.toISOString(),
      endUtc: new Date(utcMid.getTime() + 24 * 3600 * 1000 - 1).toISOString(),
    };
  }
}

export function localHourInTz(now: Date, timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' });
    const h = parseInt(fmt.formatToParts(now).find((p) => p.type === 'hour')?.value ?? '0', 10);
    return Number.isFinite(h) ? h : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

export function localHhmmInTz(iso: string, timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const parts = fmt.formatToParts(new Date(iso));
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${h}:${m}`;
  } catch {
    return '00:00';
  }
}

export { dayWindowUtcIso };

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export async function gatherOverviewPayload(args: AggregateArgs): Promise<OverviewPayload> {
  const { startUtc, endUtc } = dayWindowUtcIso(args.now, args.timezone);
  const nowIso = args.now.toISOString();
  const lookbackIso = args.lastSessionDateUserTz
    ? new Date(`${args.lastSessionDateUserTz}T00:00:00Z`).toISOString()
    : new Date(args.now.getTime() - 24 * 3600 * 1000).toISOString();

  const [
    journeyState,
    indexSnapshot,
    lcSnapshot,
    calToday,
    calPassed,
    autopilot,
    matchesUnread,
    msgsUnread,
    remindersToday,
    diary7d,
  ] = await Promise.all([
    getJourneyState(args.supabase, args.userId).catch(() => null),
    fetchVitanaIndexForProfiler(args.supabase, args.userId).catch(() => null),
    fetchLifeCompass(args.supabase, args.userId).catch(() => null),
    fetchCalendarToday(args.supabase, args.userId, nowIso, endUtc),
    fetchCalendarPassed(args.supabase, args.userId, lookbackIso, nowIso),
    fetchAutopilotForVoice(args.supabase, args.userId),
    fetchMatchesUnread(args.supabase, args.userId),
    fetchMessagesUnread(args.supabase, args.userId),
    fetchRemindersToday(args.supabase, args.userId, startUtc, endUtc),
    fetchDiaryLast7Days(args.supabase, args.userId, args.now),
  ]);

  return {
    journey: projectJourney(journeyState),
    vitana_index: projectIndex(indexSnapshot),
    life_compass: projectLifeCompass(lcSnapshot),
    calendar_today: calToday,
    calendar_passed: calPassed,
    autopilot,
    matches_unread: matchesUnread,
    messages_unread: msgsUnread,
    reminders_today: remindersToday,
    diary_last_7d: diary7d,
    last_session_date_user_tz: args.lastSessionDateUserTz,
  };
}

// ---------------------------------------------------------------------------
// Projections — narrow the shared-service shapes into the voice contract
// ---------------------------------------------------------------------------

function projectJourney(s: JourneyState | null): OverviewPayload['journey'] {
  if (!s) return null;
  const wave = s.current_wave
    ? {
        name: s.current_wave.name,
        description: s.current_wave.description,
        day_in_wave: Math.max(0, s.day_in_journey - s.current_wave.start_day + 1),
        days_to_next_wave: Math.max(0, s.current_wave.end_day - s.day_in_journey),
      }
    : null;
  return {
    day_in_journey: s.day_in_journey,
    total_days: s.total_days,
    days_left: s.days_left,
    is_first_session: s.is_first_session,
    plan_type: s.plan_type,
    current_wave: wave,
  };
}

function projectIndex(snap: any | null): OverviewPayload['vitana_index'] {
  // `snap` may be null OR a VitanaIndexSnapshot when the profiler returned state=='ok'.
  // The profiler hides the state envelope; null means either not_set_up or
  // baseline_no_score. We collapse both into 'not_set_up' here — the prompt
  // treats them identically (invite the user to set up the Index).
  if (!snap) {
    return {
      state: 'not_set_up',
      today: null, tier: null, tier_framing: null, trend_7d: null,
      weakest_pillar: null, strongest_pillar: null, balance_label: null,
      pillars: null, projected_day_90: null, projected_day_90_tier: null,
    };
  }
  return {
    state: 'ok',
    today: typeof snap.total === 'number' ? snap.total : null,
    tier: snap.tier ?? null,
    tier_framing: snap.tier_framing ?? null,
    trend_7d: typeof snap.trend_7d === 'number' ? snap.trend_7d : null,
    weakest_pillar: snap.weakest_pillar ?? null,
    strongest_pillar: snap.strongest_pillar ?? null,
    balance_label: snap.balance_label ?? null,
    pillars: snap.pillars ?? null,
    projected_day_90: typeof snap.projected_day_90 === 'number' ? snap.projected_day_90 : null,
    projected_day_90_tier: snap.projected_day_90_tier ?? null,
  };
}

function projectLifeCompass(lc: any | null): OverviewPayload['life_compass'] {
  if (!lc || !lc.primary_goal) {
    return {
      state: 'not_set',
      primary_goal: null, category: null, target_date: null,
      target_value: null, target_unit: null, starting_value: null,
      set_at: null, days_to_deadline: null, goal_progress_pct: null,
    };
  }
  const now = Date.now();
  const setAtMs = lc.set_at ? Date.parse(lc.set_at) : null;
  const deadlineMs = lc.target_date ? Date.parse(`${lc.target_date}T23:59:59Z`) : null;
  let days_to_deadline: number | null = null;
  let goal_progress_pct: number | null = null;
  if (deadlineMs && Number.isFinite(deadlineMs)) {
    days_to_deadline = Math.max(0, Math.ceil((deadlineMs - now) / 86_400_000));
    if (setAtMs && Number.isFinite(setAtMs) && deadlineMs > setAtMs) {
      const elapsed = now - setAtMs;
      const total = deadlineMs - setAtMs;
      goal_progress_pct = Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
    }
  }
  return {
    state: 'set',
    primary_goal: String(lc.primary_goal),
    category: lc.category ?? null,
    target_date: lc.target_date ?? null,
    target_value: typeof lc.target_value === 'number' ? lc.target_value : null,
    target_unit: lc.target_unit ?? null,
    starting_value: typeof lc.starting_value === 'number' ? lc.starting_value : null,
    set_at: lc.set_at ?? null,
    days_to_deadline,
    goal_progress_pct,
  };
}

// ---------------------------------------------------------------------------
// Voice-only fetchers (calendar, messages, matches, reminders, diary)
// ---------------------------------------------------------------------------

async function fetchCalendarToday(
  sb: SupabaseClient, userId: string, nowIso: string, endOfTodayIso: string,
): Promise<OverviewPayload['calendar_today']> {
  try {
    const { data, error } = await sb
      .from('calendar_events')
      .select('title, start_time')
      .eq('user_id', userId)
      .gte('start_time', nowIso)
      .lte('start_time', endOfTodayIso)
      .order('start_time', { ascending: true })
      .limit(10);
    if (error) return { count: 0, next: null };
    const rows = (data ?? []) as Array<{ title: string; start_time: string }>;
    return {
      count: rows.length,
      next: rows[0] ? { title: String(rows[0].title ?? '').trim() || 'event', start_iso: rows[0].start_time } : null,
    };
  } catch {
    return { count: 0, next: null };
  }
}

async function fetchCalendarPassed(
  sb: SupabaseClient, userId: string, lookbackIso: string, nowIso: string,
): Promise<OverviewPayload['calendar_passed']> {
  try {
    const { data, error } = await sb
      .from('calendar_events')
      .select('title, start_time')
      .eq('user_id', userId)
      .gte('start_time', lookbackIso)
      .lt('start_time', nowIso)
      .order('start_time', { ascending: false })
      .limit(5);
    if (error) return { count: 0, most_recent: null };
    const rows = (data ?? []) as Array<{ title: string; start_time: string }>;
    return {
      count: rows.length,
      most_recent: rows[0] ? { title: String(rows[0].title ?? '').trim() || 'event', start_iso: rows[0].start_time } : null,
    };
  } catch {
    return { count: 0, most_recent: null };
  }
}

/**
 * Fetch active autopilot recommendations the same way the screen does:
 * status='new' (the real default — VTID-03167's `status='pending'` query
 * was dead code, the column never carries that value). Top-1 by
 * impact_score is the TODAY checkpoint; top-3 are this_week's actions.
 *
 * setup_state distinguishes "user has actions waiting" from "user has
 * never generated any recommendations" — the prompt invites generation
 * in the second case.
 */
async function fetchAutopilotForVoice(
  sb: SupabaseClient, userId: string,
): Promise<OverviewPayload['autopilot']> {
  try {
    const { data: activeRows, error: activeErr } = await sb
      .from('autopilot_recommendations')
      .select('id, title, summary, domain, impact_score')
      .eq('user_id', userId)
      .eq('status', 'new')
      .order('impact_score', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(10);
    if (activeErr) return { state: 'has_actions', today_checkpoint: null, this_week: [], pending_total: 0 };
    const rows = (activeRows ?? []) as Array<{ id: string; title: string; summary: string | null; domain: string | null; impact_score: number | null }>;

    if (rows.length === 0) {
      // No active recs. Decide between "none_yet" (user never had any) and
      // "has_actions" with empty array (user worked through them all).
      const { count } = await sb
        .from('autopilot_recommendations')
        .select('id', { head: true, count: 'exact' })
        .eq('user_id', userId);
      return {
        state: (count ?? 0) > 0 ? 'has_actions' : 'none_yet',
        today_checkpoint: null,
        this_week: [],
        pending_total: 0,
      };
    }

    const top = rows[0];
    return {
      state: 'has_actions',
      today_checkpoint: {
        recommendation_id: top.id,
        title: String(top.title ?? '').trim() || 'next step',
        summary: top.summary ?? null,
        domain: top.domain ?? null,
        impact_score: top.impact_score ?? null,
      },
      this_week: rows.slice(0, 3).map((r) => ({
        recommendation_id: r.id,
        title: String(r.title ?? '').trim() || 'next step',
        summary: r.summary ?? null,
      })),
      pending_total: rows.length,
    };
  } catch {
    return { state: 'has_actions', today_checkpoint: null, this_week: [], pending_total: 0 };
  }
}

async function fetchMatchesUnread(sb: SupabaseClient, userId: string): Promise<number> {
  try {
    const { count, error } = await sb
      .from('match_notifications')
      .select('id', { head: true, count: 'exact' })
      .eq('user_id', userId)
      .eq('is_read', false);
    if (error) return 0;
    return Number(count ?? 0);
  } catch {
    return 0;
  }
}

async function fetchMessagesUnread(sb: SupabaseClient, userId: string): Promise<number> {
  try {
    const { count, error } = await sb
      .from('messages')
      .select('id', { head: true, count: 'exact' })
      .eq('recipient_id', userId)
      .is('read_at', null);
    if (error) return 0;
    return Number(count ?? 0);
  } catch {
    return 0;
  }
}

async function fetchRemindersToday(
  sb: SupabaseClient, userId: string, startUtc: string, endUtc: string,
): Promise<OverviewPayload['reminders_today']> {
  try {
    const { data, error } = await sb
      .from('reminders')
      .select('action_text, next_fire_at, status')
      .eq('user_id', userId)
      .gte('next_fire_at', startUtc)
      .lte('next_fire_at', endUtc)
      .in('status', ['scheduled', 'pending', 'queued'])
      .order('next_fire_at', { ascending: true })
      .limit(5);
    if (error) return { count: 0, next: null };
    const rows = (data ?? []) as Array<{ action_text: string; next_fire_at: string }>;
    return {
      count: rows.length,
      next: rows[0] ? { action_text: String(rows[0].action_text ?? '').trim() || 'a reminder', next_fire_at: rows[0].next_fire_at } : null,
    };
  } catch {
    return { count: 0, next: null };
  }
}

async function fetchDiaryLast7Days(sb: SupabaseClient, userId: string, now: Date): Promise<number> {
  try {
    const sinceIso = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
    const { count, error } = await sb
      .from('diary_entries')
      .select('id', { head: true, count: 'exact' })
      .eq('user_id', userId)
      .gte('created_at', sinceIso);
    if (error) return 0;
    return Number(count ?? 0);
  } catch {
    return 0;
  }
}
