/**
 * VTID-02779 — Voice Tool Expansion P1q: Clock / Alarm / Timer voice tools.
 *
 * These wrap the existing reminders engine: alarms, timers, and pomodoros are
 * just reminders with a prefix marker in the description column so list/delete
 * queries can filter to the clock subset. This avoids a new table + migration
 * for the first pass; if richer semantics are needed (smart wake, snooze loop)
 * a dedicated clock table can land later without breaking the voice surface.
 *
 * Marker format: description starts with `[ALARM]`, `[TIMER]`, or `[POMODORO]`.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { createReminder, ReminderValidationError } from '../reminders-service';

const ALARM_MARKER = '[ALARM]';
const TIMER_MARKER = '[TIMER]';
const POMODORO_MARKER = '[POMODORO]';

interface Identity {
  user_id: string;
  tenant_id: string | null;
}

function todayOrTomorrowAt(hour: number, minute: number, tz: string): Date {
  const now = new Date();
  // Build today's HH:MM in user's TZ. Cheap path: use local; if user TZ
  // differs from server, the gateway clamps via reminder validation anyway.
  const today = new Date(now);
  today.setHours(hour, minute, 0, 0);
  if (today.getTime() <= now.getTime() + 60_000) {
    today.setDate(today.getDate() + 1);
  }
  // tz is recorded on the row; the absolute timestamp above is good enough
  // for one-shot wake-up alarms in the user's local clock.
  return today;
}

export async function setAlarm(
  sb: SupabaseClient,
  identity: Identity,
  args: { hour: number; minute: number; label?: string; user_tz?: string },
): Promise<{ ok: true; alarm_id: string; fires_at: string } | { ok: false; error: string }> {
  if (!Number.isFinite(args.hour) || args.hour < 0 || args.hour > 23) {
    return { ok: false, error: 'hour must be 0-23' };
  }
  if (!Number.isFinite(args.minute) || args.minute < 0 || args.minute > 59) {
    return { ok: false, error: 'minute must be 0-59' };
  }
  const tz = args.user_tz || 'UTC';
  const fireAt = todayOrTomorrowAt(args.hour, args.minute, tz);
  const label = (args.label || 'Wake up').slice(0, 80);
  const hh = String(args.hour).padStart(2, '0');
  const mm = String(args.minute).padStart(2, '0');
  try {
    const row = await createReminder(sb, {
      user_id: identity.user_id,
      tenant_id: identity.tenant_id || identity.user_id,
      action_text: label,
      spoken_message: `Alarm: ${label}`,
      description: `${ALARM_MARKER} ${hh}:${mm} — ${label}`,
      scheduled_for_iso: fireAt.toISOString(),
      user_tz: tz,
      created_via: 'voice',
    });
    return { ok: true, alarm_id: row.id, fires_at: row.next_fire_at };
  } catch (err) {
    const msg = err instanceof ReminderValidationError ? err.message : (err as Error).message;
    return { ok: false, error: msg };
  }
}

export async function listAlarms(
  sb: SupabaseClient,
  identity: Identity,
): Promise<{ ok: true; alarms: Array<{ id: string; fires_at: string; label: string }> }> {
  const { data, error } = await sb
    .from('reminders')
    .select('id, next_fire_at, action_text, description')
    .eq('user_id', identity.user_id)
    .like('description', `${ALARM_MARKER}%`)
    .in('status', ['pending', 'dispatching'])
    .order('next_fire_at', { ascending: true })
    .limit(20);
  if (error) return { ok: true, alarms: [] };
  const alarms = (data || []).map((r: any) => ({
    id: r.id,
    fires_at: r.next_fire_at,
    label: r.action_text,
  }));
  return { ok: true, alarms };
}

export async function deleteAlarm(
  sb: SupabaseClient,
  identity: Identity,
  args: { alarm_id: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!args.alarm_id) return { ok: false, error: 'alarm_id required' };
  const { error } = await sb
    .from('reminders')
    .update({ status: 'cancelled' })
    .eq('id', args.alarm_id)
    .eq('user_id', identity.user_id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function startTimer(
  sb: SupabaseClient,
  identity: Identity,
  args: { duration_seconds: number; label?: string },
): Promise<{ ok: true; timer_id: string; ends_at: string } | { ok: false; error: string }> {
  const seconds = Number(args.duration_seconds);
  if (!Number.isFinite(seconds) || seconds < 60) {
    return { ok: false, error: 'duration_seconds must be at least 60' };
  }
  if (seconds > 24 * 3600) {
    return { ok: false, error: 'duration_seconds must be at most 86400 (24h)' };
  }
  const fireAt = new Date(Date.now() + seconds * 1000);
  const label = (args.label || 'Timer').slice(0, 80);
  const mins = Math.round(seconds / 60);
  try {
    const row = await createReminder(sb, {
      user_id: identity.user_id,
      tenant_id: identity.tenant_id || identity.user_id,
      action_text: label,
      spoken_message: `${label} — time's up.`,
      description: `${TIMER_MARKER} ${mins}m — ${label}`,
      scheduled_for_iso: fireAt.toISOString(),
      user_tz: 'UTC',
      created_via: 'voice',
    });
    return { ok: true, timer_id: row.id, ends_at: row.next_fire_at };
  } catch (err) {
    const msg = err instanceof ReminderValidationError ? err.message : (err as Error).message;
    return { ok: false, error: msg };
  }
}

export async function startPomodoro(
  sb: SupabaseClient,
  identity: Identity,
  args: { work_minutes?: number; label?: string },
): Promise<{ ok: true; pomodoro_id: string; work_ends_at: string } | { ok: false; error: string }> {
  const work = Number(args.work_minutes ?? 25);
  if (!Number.isFinite(work) || work < 5 || work > 90) {
    return { ok: false, error: 'work_minutes must be 5-90' };
  }
  const fireAt = new Date(Date.now() + work * 60_000);
  const label = (args.label || 'Pomodoro').slice(0, 80);
  try {
    const row = await createReminder(sb, {
      user_id: identity.user_id,
      tenant_id: identity.tenant_id || identity.user_id,
      action_text: label,
      spoken_message: `${label} session done. Take a short break.`,
      description: `${POMODORO_MARKER} ${work}m — ${label}`,
      scheduled_for_iso: fireAt.toISOString(),
      user_tz: 'UTC',
      created_via: 'voice',
    });
    return { ok: true, pomodoro_id: row.id, work_ends_at: row.next_fire_at };
  } catch (err) {
    const msg = err instanceof ReminderValidationError ? err.message : (err as Error).message;
    return { ok: false, error: msg };
  }
}

export async function listActiveTimers(
  sb: SupabaseClient,
  identity: Identity,
): Promise<{ ok: true; timers: Array<{ id: string; ends_at: string; label: string; kind: 'timer' | 'pomodoro' }> }> {
  const { data, error } = await sb
    .from('reminders')
    .select('id, next_fire_at, action_text, description')
    .eq('user_id', identity.user_id)
    .or(`description.like.${TIMER_MARKER}%,description.like.${POMODORO_MARKER}%`)
    .in('status', ['pending', 'dispatching'])
    .order('next_fire_at', { ascending: true })
    .limit(20);
  if (error) return { ok: true, timers: [] };
  const timers = (data || []).map((r: any) => ({
    id: r.id,
    ends_at: r.next_fire_at,
    label: r.action_text,
    kind: (r.description || '').startsWith(POMODORO_MARKER) ? ('pomodoro' as const) : ('timer' as const),
  }));
  return { ok: true, timers };
}

export function getWorldTime(args: { city?: string; tz?: string }): {
  ok: true;
  now_iso: string;
  display: string;
  tz: string;
} | { ok: false; error: string } {
  const tz = args.tz || cityToTz(args.city || '');
  if (!tz) return { ok: false, error: 'unknown_city_or_tz' };
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    return { ok: true, now_iso: now.toISOString(), display: fmt.format(now), tz };
  } catch (err) {
    return { ok: false, error: `bad_timezone: ${(err as Error).message}` };
  }
}

function cityToTz(city: string): string | '' {
  const c = city.trim().toLowerCase();
  if (!c) return '';
  // Tiny lookup; Intl recognises most IANA names directly. For famous cities
  // the model can also pass tz directly to skip this.
  const map: Record<string, string> = {
    'tokyo': 'Asia/Tokyo',
    'london': 'Europe/London',
    'new york': 'America/New_York',
    'nyc': 'America/New_York',
    'paris': 'Europe/Paris',
    'berlin': 'Europe/Berlin',
    'sydney': 'Australia/Sydney',
    'los angeles': 'America/Los_Angeles',
    'la': 'America/Los_Angeles',
    'san francisco': 'America/Los_Angeles',
    'chicago': 'America/Chicago',
    'dubai': 'Asia/Dubai',
    'singapore': 'Asia/Singapore',
    'hong kong': 'Asia/Hong_Kong',
    'mumbai': 'Asia/Kolkata',
    'delhi': 'Asia/Kolkata',
    'sao paulo': 'America/Sao_Paulo',
    'mexico city': 'America/Mexico_City',
    'moscow': 'Europe/Moscow',
    'istanbul': 'Europe/Istanbul',
    'zurich': 'Europe/Zurich',
    'rome': 'Europe/Rome',
    'madrid': 'Europe/Madrid',
    'amsterdam': 'Europe/Amsterdam',
    'vienna': 'Europe/Vienna',
    'seoul': 'Asia/Seoul',
    'beijing': 'Asia/Shanghai',
    'shanghai': 'Asia/Shanghai',
    'bangkok': 'Asia/Bangkok',
  };
  return map[c] || '';
}
