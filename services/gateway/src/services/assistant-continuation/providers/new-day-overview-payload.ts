/**
 * VTID-03167 — Broad new-day overview payload aggregator.
 *
 * REPLACES the Slice 2 (VTID-03166) renderer that pre-composed German /
 * English sentences server-side. The founder's contract:
 *
 *   1. The aggregator pulls EVERY available signal in parallel.
 *   2. The structured payload is handed to Gemini via a STRUCTURAL
 *      prompt block — NOT a Say-exactly line, NOT pre-composed sentences.
 *   3. Gemini composes the multi-paragraph overview in the user's
 *      language, conversationally, addressing every signal that has data.
 *   4. Zero hardcoded sentences in TypeScript. Zero sentence templates.
 *      This file ONLY produces the structured payload.
 *
 * Sources pulled (all best-effort, per-source try/catch):
 *   - Vitana Index (today total + per-pillar + weakest pillar)
 *   - Life Compass (active goal + category)
 *   - Calendar today (count + next event)
 *   - Calendar passed since last session (count + most recent)
 *   - Autopilot pending recommendations (count + top title)
 *   - Match notifications unread (count)
 *   - Messages unread (count + sender hint when possible)
 *   - Reminders due today (count + next reminder)
 *   - Diary entries last 7 days (streak proxy)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface OverviewPayload {
  // -- VITANA INDEX --
  vitana_index: {
    total: number;             // 0-999 (server-computed from score_total)
    pillars: { sleep: number; nutrition: number; exercise: number; hydration: number; mental: number };
    weakest_pillar: 'sleep' | 'nutrition' | 'exercise' | 'hydration' | 'mental' | null;
  } | null;

  // -- LIFE COMPASS --
  life_compass: {
    primary_goal: string;        // free text (user's words, language as stored)
    category: string;            // e.g. 'wealth', 'health', 'relationships'
  } | null;

  // -- CALENDAR --
  calendar_today: {
    count: number;               // events scheduled today (in user TZ today)
    next: { title: string; start_iso: string } | null;  // chronologically first today
  };
  calendar_passed: {
    count: number;               // events in (lookback, now)
    most_recent: { title: string; start_iso: string } | null;
  };

  // -- AUTOPILOT --
  autopilot_pending: {
    count: number;
    top: { title: string; domain: string | null } | null;
  };

  // -- MATCHES --
  matches_unread: number;       // open match_notifications

  // -- MESSAGES --
  messages_unread: number;      // unread messages in inbox

  // -- REMINDERS --
  reminders_today: {
    count: number;
    next: { action_text: string; next_fire_at: string } | null;
  };

  // -- DIARY (streak proxy) --
  diary_last_7d: number;

  // -- META (for the renderer's context) --
  last_session_date_user_tz: string | null;     // YYYY-MM-DD or null
}

export interface AggregateArgs {
  supabase: SupabaseClient;
  userId: string;
  timezone: string;             // IANA TZ e.g. 'Europe/Berlin'
  now: Date;
  lastSessionDateUserTz: string | null;  // YYYY-MM-DD or null (from user_journey)
}

/** UTC day-window matching local day in `timezone`. */
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

/** Local hour [0-23] in IANA TZ. */
export function localHourInTz(now: Date, timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' });
    const h = parseInt(fmt.formatToParts(now).find((p) => p.type === 'hour')?.value ?? '0', 10);
    return Number.isFinite(h) ? h : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

/** Local time HH:MM in IANA TZ for use in payload. */
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

const EMPTY_VITANA_INDEX: OverviewPayload['vitana_index'] = null;

function pickWeakest(p: { sleep: number; nutrition: number; exercise: number; hydration: number; mental: number }): OverviewPayload['vitana_index'] extends infer T ? T extends { weakest_pillar: infer W } ? W : never : never {
  const entries: Array<[keyof typeof p, number]> = [
    ['sleep', p.sleep],
    ['nutrition', p.nutrition],
    ['exercise', p.exercise],
    ['hydration', p.hydration],
    ['mental', p.mental],
  ];
  entries.sort((a, b) => a[1] - b[1]);
  const lowest = entries[0][1];
  // If all five pillars are tied (e.g., baseline survey state), return null —
  // the LLM should be told "all pillars need attention" via the absence of a
  // single weakest, not pick one arbitrarily.
  const tiedCount = entries.filter(([, v]) => v === lowest).length;
  if (tiedCount >= 4) return null as any;
  return entries[0][0] as any;
}

/** Aggregate the full overview payload. Never throws. Per-source failures degrade fields to null/0. */
export async function gatherOverviewPayload(args: AggregateArgs): Promise<OverviewPayload> {
  const { startUtc, endUtc } = dayWindowUtcIso(args.now, args.timezone);
  const nowIso = args.now.toISOString();
  const lookbackIso = args.lastSessionDateUserTz
    ? new Date(`${args.lastSessionDateUserTz}T00:00:00Z`).toISOString()
    : new Date(args.now.getTime() - 24 * 3600 * 1000).toISOString();

  const [
    vIdx,
    lc,
    calToday,
    calPassed,
    autoP,
    matchesUnread,
    msgsUnread,
    remindersToday,
    diary7d,
  ] = await Promise.all([
    fetchVitanaIndexLatest(args.supabase, args.userId),
    fetchLifeCompass(args.supabase, args.userId),
    fetchCalendarToday(args.supabase, args.userId, nowIso, endUtc),
    fetchCalendarPassed(args.supabase, args.userId, lookbackIso, nowIso),
    fetchAutopilotPending(args.supabase, args.userId),
    fetchMatchesUnread(args.supabase, args.userId),
    fetchMessagesUnread(args.supabase, args.userId),
    fetchRemindersToday(args.supabase, args.userId, startUtc, endUtc),
    fetchDiaryLast7Days(args.supabase, args.userId, args.now),
  ]);

  return {
    vitana_index: vIdx,
    life_compass: lc,
    calendar_today: calToday,
    calendar_passed: calPassed,
    autopilot_pending: autoP,
    matches_unread: matchesUnread,
    messages_unread: msgsUnread,
    reminders_today: remindersToday,
    diary_last_7d: diary7d,
    last_session_date_user_tz: args.lastSessionDateUserTz,
  };
}

// -------------------- per-source fetchers (defensive) --------------------

async function fetchVitanaIndexLatest(sb: SupabaseClient, userId: string): Promise<OverviewPayload['vitana_index']> {
  try {
    const { data, error } = await sb
      .from('vitana_index_scores')
      .select('score_total, score_sleep, score_nutrition, score_exercise, score_hydration, score_mental')
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return EMPTY_VITANA_INDEX;
    const pillars = {
      sleep: Number(data.score_sleep) || 0,
      nutrition: Number(data.score_nutrition) || 0,
      exercise: Number(data.score_exercise) || 0,
      hydration: Number(data.score_hydration) || 0,
      mental: Number(data.score_mental) || 0,
    };
    return {
      total: Number(data.score_total) || 0,
      pillars,
      weakest_pillar: pickWeakest(pillars),
    };
  } catch {
    return EMPTY_VITANA_INDEX;
  }
}

async function fetchLifeCompass(sb: SupabaseClient, userId: string): Promise<OverviewPayload['life_compass']> {
  try {
    const { data, error } = await sb
      .from('life_compass')
      .select('primary_goal, category')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data || !data.primary_goal) return null;
    return {
      primary_goal: String(data.primary_goal),
      category: String(data.category ?? ''),
    };
  } catch {
    return null;
  }
}

async function fetchCalendarToday(sb: SupabaseClient, userId: string, nowIso: string, endOfTodayIso: string): Promise<OverviewPayload['calendar_today']> {
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

async function fetchCalendarPassed(sb: SupabaseClient, userId: string, lookbackIso: string, nowIso: string): Promise<OverviewPayload['calendar_passed']> {
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

async function fetchAutopilotPending(sb: SupabaseClient, userId: string): Promise<OverviewPayload['autopilot_pending']> {
  try {
    const { data, error } = await sb
      .from('autopilot_recommendations')
      .select('title, domain')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) return { count: 0, top: null };
    const rows = (data ?? []) as Array<{ title: string; domain: string | null }>;
    return {
      count: rows.length,
      top: rows[0] ? { title: String(rows[0].title ?? '').trim() || 'recommendation', domain: rows[0].domain ?? null } : null,
    };
  } catch {
    return { count: 0, top: null };
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

async function fetchRemindersToday(sb: SupabaseClient, userId: string, startUtc: string, endUtc: string): Promise<OverviewPayload['reminders_today']> {
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

// dayWindowUtcIso exported for tests + the new-day-return provider integration.
export { dayWindowUtcIso };
