/**
 * Reminders lifecycle + Clock voice tools (VTID-02763, VTID-02779).
 *
 * Extends the VTID-02601 reminders feature (set_reminder / find_reminders /
 * delete_reminder) with the full lifecycle the REST routes already support —
 * snooze, edit, acknowledge, complete, missed-list — reusing the same
 * `reminders` table + status machine (pending|dispatching|fired|completed|
 * failed|cancelled, acked_at, snooze_count). Adds a voice clock (alarms,
 * countdown timers, pomodoro blocks) backed by the new `voice_clock_items`
 * table (migration 20260706100000_vtid_02779_voice_clock.sql), plus a
 * network-free world-clock lookup via Intl time zones. NOTE: alarm/timer
 * FIRING (push/chime when fires_at passes) needs a cron tick follow-up —
 * this module ships the data layer + read/write tools.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { findReminders, formatTimeForVoice, type ReminderRow } from '../reminders-service';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

// ---------------------------------------------------------------------------
// Shared helpers — reminders
// ---------------------------------------------------------------------------

/** Statuses a reminder can be acted on from (matches VTID-02601 routes). */
const ACTIVE_REMINDER_STATUSES = ['pending', 'dispatching', 'fired'];

const MIN_LEAD_MS = 60_000; // same 60s floor as reminders-service / PATCH route

function strArg(args: OrbToolArgs, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

function langOf(id: OrbToolIdentity): string {
  return (id.lang || 'en').slice(0, 5);
}

type ReminderResolution =
  | { kind: 'found'; row: ReminderRow }
  | { kind: 'none'; message: string }
  | { kind: 'ambiguous'; rows: ReminderRow[] };

/**
 * Resolve a single reminder by explicit reminder_id or free-text query.
 * Text search reuses findReminders (ilike on action_text + spoken_message).
 */
async function resolveReminder(
  sb: SupabaseClient,
  userId: string,
  args: OrbToolArgs,
): Promise<ReminderResolution> {
  const reminderId = strArg(args, 'reminder_id');
  const textQuery = strArg(args, 'text_query');

  if (reminderId) {
    const { data, error } = await sb
      .from('reminders')
      .select('*')
      .eq('id', reminderId)
      .eq('user_id', userId)
      .in('status', ACTIVE_REMINDER_STATUSES)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { kind: 'none', message: 'No active reminder found with that id.' };
    return { kind: 'found', row: data as ReminderRow };
  }

  const rows = await findReminders(sb, userId, {
    query: textQuery,
    include_fired: true,
    limit: 5,
  });
  if (rows.length === 0) {
    return { kind: 'none', message: `No active reminder matches "${textQuery}".` };
  }
  if (rows.length > 1) return { kind: 'ambiguous', rows };
  return { kind: 'found', row: rows[0] };
}

function ambiguousRemindersText(rows: ReminderRow[], lang: string): string {
  const list = rows
    .map(
      (r, i) =>
        `${i + 1}. "${r.action_text}" at ${formatTimeForVoice(
          new Date(r.next_fire_at),
          r.user_tz,
          lang,
        )} (id ${r.id})`,
    )
    .join('; ');
  return `I found ${rows.length} matching reminders: ${list}. Ask the user which one they mean, then call the tool again with that reminder_id.`;
}

// ---------------------------------------------------------------------------
// Reminders lifecycle handlers (VTID-02763)
// ---------------------------------------------------------------------------

export async function tool_snooze_reminder(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'snooze_reminder requires an authenticated user.' };
  if (!strArg(args, 'reminder_id') && !strArg(args, 'text_query')) {
    return { ok: false, error: 'snooze_reminder needs reminder_id or text_query.' };
  }
  try {
    const rawMinutes = Number(args.minutes);
    const minutes = Math.max(1, Math.min(Number.isFinite(rawMinutes) ? Math.round(rawMinutes) : 10, 24 * 60));

    const resolved = await resolveReminder(sb, id.user_id, args);
    if (resolved.kind === 'none') return { ok: false, error: resolved.message };
    if (resolved.kind === 'ambiguous') {
      return { ok: true, result: { ambiguous: true, count: resolved.rows.length }, text: ambiguousRemindersText(resolved.rows, langOf(id)) };
    }
    const row = resolved.row;

    const newTimeIso = new Date(Date.now() + minutes * 60_000).toISOString();
    const { data, error } = await sb
      .from('reminders')
      .update({
        next_fire_at: newTimeIso,
        status: 'pending',
        fired_at: null,
        acked_at: null,
        delivery_via: null,
        snooze_count: (row.snooze_count || 0) + 1,
      })
      .eq('id', row.id)
      .eq('user_id', id.user_id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    const human = formatTimeForVoice(new Date(newTimeIso), row.user_tz, langOf(id));
    return {
      ok: true,
      result: { reminder_id: row.id, action_text: row.action_text, next_fire_at: newTimeIso, snoozed_minutes: minutes },
      text: `Snoozed "${row.action_text}" by ${minutes} minutes — it will fire again at ${human}. (Snoozed ${(data as ReminderRow).snooze_count} time(s) so far.)`,
    };
  } catch (err: any) {
    return { ok: false, error: `snooze_reminder failed: ${err?.message || 'unknown error'}` };
  }
}

export async function tool_update_reminder(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'update_reminder requires an authenticated user.' };
  if (!strArg(args, 'reminder_id') && !strArg(args, 'text_query')) {
    return { ok: false, error: 'update_reminder needs reminder_id or text_query.' };
  }
  const newText = strArg(args, 'new_text');
  const newTime = strArg(args, 'new_time');
  if (!newText && !newTime) {
    return { ok: false, error: 'update_reminder needs new_text and/or new_time.' };
  }
  try {
    const resolved = await resolveReminder(sb, id.user_id, args);
    if (resolved.kind === 'none') return { ok: false, error: resolved.message };
    if (resolved.kind === 'ambiguous') {
      return { ok: true, result: { ambiguous: true, count: resolved.rows.length }, text: ambiguousRemindersText(resolved.rows, langOf(id)) };
    }
    const row = resolved.row;

    const updates: Record<string, unknown> = {};
    const changes: string[] = [];
    let fireAtForVoice = new Date(row.next_fire_at);

    if (newText) {
      if (newText.length > 200) return { ok: false, error: 'new_text too long (max 200 chars).' };
      updates.action_text = newText;
      updates.spoken_message = newText;
      updates.tts_audio_b64 = null; // pre-rendered audio is stale — re-render at fire time
      changes.push(`text changed to "${newText}"`);
    }
    if (newTime) {
      const t = new Date(newTime);
      if (isNaN(t.getTime())) return { ok: false, error: `new_time is not a valid timestamp: ${newTime}` };
      if (t.getTime() < Date.now() + MIN_LEAD_MS) {
        return { ok: false, error: 'new_time must be at least 60 seconds in the future.' };
      }
      updates.next_fire_at = t.toISOString();
      updates.status = 'pending';
      updates.fired_at = null;
      updates.acked_at = null;
      updates.delivery_via = null;
      fireAtForVoice = t;
      changes.push(`time changed to ${formatTimeForVoice(t, row.user_tz, langOf(id))}`);
    }

    const { data, error } = await sb
      .from('reminders')
      .update(updates)
      .eq('id', row.id)
      .eq('user_id', id.user_id)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { ok: false, error: 'Reminder not found or already cancelled.' };

    const updated = data as ReminderRow;
    return {
      ok: true,
      result: { reminder_id: updated.id, action_text: updated.action_text, next_fire_at: updated.next_fire_at },
      text: `Updated the reminder "${row.action_text}": ${changes.join(' and ')}. It will fire at ${formatTimeForVoice(fireAtForVoice, row.user_tz, langOf(id))}.`,
    };
  } catch (err: any) {
    return { ok: false, error: `update_reminder failed: ${err?.message || 'unknown error'}` };
  }
}

export async function tool_acknowledge_reminder(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'acknowledge_reminder requires an authenticated user.' };
  if (!strArg(args, 'reminder_id') && !strArg(args, 'text_query')) {
    return { ok: false, error: 'acknowledge_reminder needs reminder_id or text_query.' };
  }
  try {
    const resolved = await resolveReminder(sb, id.user_id, args);
    if (resolved.kind === 'none') return { ok: false, error: resolved.message };
    if (resolved.kind === 'ambiguous') {
      return { ok: true, result: { ambiguous: true, count: resolved.rows.length }, text: ambiguousRemindersText(resolved.rows, langOf(id)) };
    }
    const row = resolved.row;

    const { data, error } = await sb
      .from('reminders')
      .update({ acked_at: new Date().toISOString(), delivery_via: 'manual' })
      .eq('id', row.id)
      .eq('user_id', id.user_id)
      .select('id, acked_at, delivery_via, action_text, status')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { ok: false, error: 'Reminder not found or already cancelled.' };

    return {
      ok: true,
      result: { reminder_id: row.id, action_text: row.action_text, acked_at: (data as any).acked_at },
      text: `Acknowledged the reminder "${row.action_text}" — it won't be re-delivered.`,
    };
  } catch (err: any) {
    return { ok: false, error: `acknowledge_reminder failed: ${err?.message || 'unknown error'}` };
  }
}

export async function tool_complete_reminder(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'complete_reminder requires an authenticated user.' };
  if (!strArg(args, 'reminder_id') && !strArg(args, 'text_query')) {
    return { ok: false, error: 'complete_reminder needs reminder_id or text_query.' };
  }
  try {
    const resolved = await resolveReminder(sb, id.user_id, args);
    if (resolved.kind === 'none') return { ok: false, error: resolved.message };
    if (resolved.kind === 'ambiguous') {
      return { ok: true, result: { ambiguous: true, count: resolved.rows.length }, text: ambiguousRemindersText(resolved.rows, langOf(id)) };
    }
    const row = resolved.row;

    const { data, error } = await sb
      .from('reminders')
      .update({ status: 'completed', acked_at: new Date().toISOString(), delivery_via: 'manual' })
      .eq('id', row.id)
      .eq('user_id', id.user_id)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { ok: false, error: 'Reminder not found or already cancelled.' };

    return {
      ok: true,
      result: { reminder_id: row.id, action_text: row.action_text, status: 'completed' },
      text: `Done — marked the reminder "${row.action_text}" as completed.`,
    };
  } catch (err: any) {
    return { ok: false, error: `complete_reminder failed: ${err?.message || 'unknown error'}` };
  }
}

export async function tool_list_missed_reminders(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'list_missed_reminders requires an authenticated user.' };
  try {
    const { data, error } = await sb
      .from('reminders')
      .select('*')
      .eq('user_id', id.user_id)
      .eq('status', 'fired')
      .is('acked_at', null)
      .order('fired_at', { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);

    const rows = (data || []) as ReminderRow[];
    if (rows.length === 0) {
      return { ok: true, result: { count: 0, reminders: [] }, text: 'You have no missed reminders — everything fired was acknowledged.' };
    }

    const lang = langOf(id);
    const list = rows
      .map(
        (r, i) =>
          `${i + 1}. "${r.action_text}" (fired ${formatTimeForVoice(
            new Date(r.fired_at || r.next_fire_at),
            r.user_tz,
            lang,
          )})`,
      )
      .join('; ');
    return {
      ok: true,
      result: {
        count: rows.length,
        reminders: rows.map((r) => ({ reminder_id: r.id, action_text: r.action_text, fired_at: r.fired_at })),
      },
      text: `You have ${rows.length} missed reminder(s): ${list}. The user can snooze, complete, or acknowledge each one.`,
    };
  } catch (err: any) {
    return { ok: false, error: `list_missed_reminders failed: ${err?.message || 'unknown error'}` };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers — clock (VTID-02779)
// ---------------------------------------------------------------------------

const CLOCK_TABLE = 'voice_clock_items';

export interface VoiceClockItemRow {
  id: string;
  tenant_id: string | null;
  user_id: string;
  kind: 'alarm' | 'timer' | 'pomodoro';
  label: string | null;
  fires_at: string | null;
  recurrence: string | null;
  duration_seconds: number | null;
  status: 'active' | 'fired' | 'cancelled' | 'completed';
  created_at: string;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) to add to a UTC instant to get the wall clock in `tz`. */
function tzOffsetMs(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24, // Intl emits "24" for midnight in some locales
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - at.getTime();
}

/**
 * Compute the next absolute fire instant for an alarm.
 * `time` is "HH:MM" (interpreted in `tz`, next occurrence, skipping to Mon-Fri
 * when recurrence='weekdays') or an absolute ISO timestamp (used as-is).
 */
export function computeNextAlarmFire(
  time: string,
  tz: string,
  recurrence: string | null,
): { fires_at?: Date; error?: string } {
  const hhmm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (hhmm) {
    const hour = Number(hhmm[1]);
    const minute = Number(hhmm[2]);
    const now = new Date();
    const offset = tzOffsetMs(tz, now);
    const wallNow = now.getTime() + offset;
    const w = new Date(wallNow);
    let candidateWall = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), hour, minute, 0);
    if (candidateWall <= wallNow) candidateWall += 86_400_000;
    if (recurrence === 'weekdays') {
      while ([0, 6].includes(new Date(candidateWall).getUTCDay())) candidateWall += 86_400_000;
    }
    // Recompute the offset at the candidate instant so DST transitions land right.
    const offsetAtFire = tzOffsetMs(tz, new Date(candidateWall - offset));
    return { fires_at: new Date(candidateWall - offsetAtFire) };
  }

  const parsed = new Date(time);
  if (isNaN(parsed.getTime())) {
    return { error: `"${time}" is not a valid time. Use "HH:MM" (24h) or an ISO timestamp.` };
  }
  if (parsed.getTime() <= Date.now()) {
    return { error: 'That time is in the past — give a future time.' };
  }
  return { fires_at: parsed };
}

function fmtInTz(d: Date, tz: string, opts: Intl.DateTimeFormatOptions, locale = 'en'): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }).format(d);
  } catch {
    return d.toISOString();
  }
}

function fmtAlarmTime(d: Date, tz: string, locale: string): string {
  return fmtInTz(d, tz, { weekday: 'long', hour: 'numeric', minute: '2-digit' }, locale);
}

function resolveTzArg(args: OrbToolArgs): { tz: string; error?: string } {
  const raw = strArg(args, 'timezone');
  if (!raw) return { tz: 'UTC' }; // documented assumption: UTC when the model omits timezone
  if (!isValidTimeZone(raw)) {
    return { tz: 'UTC', error: `"${raw}" is not a valid IANA timezone (e.g. Europe/Berlin).` };
  }
  return { tz: raw };
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'finished';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (!h && (s || parts.length === 0)) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return `${parts.join(' ')} remaining`;
}

// ---------------------------------------------------------------------------
// Clock handlers (VTID-02779)
// ---------------------------------------------------------------------------

export async function tool_set_alarm(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'set_alarm requires an authenticated user.' };
  try {
    const time = strArg(args, 'time');
    if (!time) return { ok: false, error: 'set_alarm needs a time ("HH:MM" or ISO timestamp).' };

    const recurrenceRaw = strArg(args, 'recurrence');
    if (recurrenceRaw && !['daily', 'weekdays'].includes(recurrenceRaw)) {
      return { ok: false, error: `Unsupported recurrence "${recurrenceRaw}" — use "daily", "weekdays", or omit for one-shot.` };
    }
    const recurrence = recurrenceRaw || null;

    const { tz, error: tzError } = resolveTzArg(args);
    if (tzError) return { ok: false, error: tzError };

    const next = computeNextAlarmFire(time, tz, recurrence);
    if (!next.fires_at) return { ok: false, error: next.error || 'Could not compute the alarm time.' };

    const label = strArg(args, 'label') || null;
    const { data, error } = await sb
      .from(CLOCK_TABLE)
      .insert({
        tenant_id: id.tenant_id ?? null,
        user_id: id.user_id,
        kind: 'alarm',
        label,
        fires_at: next.fires_at.toISOString(),
        recurrence,
        status: 'active',
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    const row = data as VoiceClockItemRow;
    const when = fmtAlarmTime(next.fires_at, tz, langOf(id));
    const repeat = recurrence === 'daily' ? ', repeating daily' : recurrence === 'weekdays' ? ', repeating on weekdays' : '';
    return {
      ok: true,
      result: { alarm_id: row.id, fires_at: row.fires_at, recurrence, label, timezone: tz },
      text: `Alarm set for ${when}${label ? ` — "${label}"` : ''}${repeat} (timezone ${tz}).`,
    };
  } catch (err: any) {
    return { ok: false, error: `set_alarm failed: ${err?.message || 'unknown error'}` };
  }
}

export async function tool_list_alarms(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'list_alarms requires an authenticated user.' };
  try {
    const { tz } = resolveTzArg(args); // invalid tz just falls back to UTC for display
    const { data, error } = await sb
      .from(CLOCK_TABLE)
      .select('*')
      .eq('user_id', id.user_id)
      .eq('kind', 'alarm')
      .eq('status', 'active')
      .order('fires_at', { ascending: true })
      .limit(20);
    if (error) throw new Error(error.message);

    const rows = (data || []) as VoiceClockItemRow[];
    if (rows.length === 0) {
      return { ok: true, result: { count: 0, alarms: [] }, text: 'You have no active alarms.' };
    }
    const lang = langOf(id);
    const list = rows
      .map((r, i) => {
        const when = r.fires_at ? fmtAlarmTime(new Date(r.fires_at), tz, lang) : 'unscheduled';
        const repeat = r.recurrence === 'daily' ? ', daily' : r.recurrence === 'weekdays' ? ', weekdays' : '';
        return `${i + 1}. ${when}${r.label ? ` — "${r.label}"` : ''}${repeat}`;
      })
      .join('; ');
    return {
      ok: true,
      result: {
        count: rows.length,
        alarms: rows.map((r) => ({ alarm_id: r.id, label: r.label, fires_at: r.fires_at, recurrence: r.recurrence })),
      },
      text: `You have ${rows.length} active alarm(s): ${list}.`,
    };
  } catch (err: any) {
    return { ok: false, error: `list_alarms failed: ${err?.message || 'unknown error'}` };
  }
}

export async function tool_delete_alarm(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'delete_alarm requires an authenticated user.' };
  try {
    const alarmId = strArg(args, 'alarm_id');
    const label = strArg(args, 'label');
    const time = strArg(args, 'time');
    if (!alarmId && !label && !time) {
      return { ok: false, error: 'delete_alarm needs alarm_id, or a label/time to match.' };
    }

    const { data, error } = await sb
      .from(CLOCK_TABLE)
      .select('*')
      .eq('user_id', id.user_id)
      .eq('kind', 'alarm')
      .eq('status', 'active')
      .order('fires_at', { ascending: true })
      .limit(20);
    if (error) throw new Error(error.message);
    const all = (data || []) as VoiceClockItemRow[];

    const { tz } = resolveTzArg(args);
    const lang = langOf(id);
    let matches = all;
    if (alarmId) matches = matches.filter((r) => r.id === alarmId);
    if (label) matches = matches.filter((r) => (r.label || '').toLowerCase().includes(label.toLowerCase()));
    if (time) {
      matches = matches.filter(
        (r) => r.fires_at && fmtInTz(new Date(r.fires_at), tz, { hour: '2-digit', minute: '2-digit', hour12: false }) === time.padStart(5, '0'),
      );
    }

    if (matches.length === 0) return { ok: false, error: 'No active alarm matches that — call list_alarms to see what exists.' };
    if (matches.length > 1) {
      const list = matches
        .map((r, i) => `${i + 1}. ${r.fires_at ? fmtAlarmTime(new Date(r.fires_at), tz, lang) : 'unscheduled'}${r.label ? ` — "${r.label}"` : ''} (id ${r.id})`)
        .join('; ');
      return {
        ok: true,
        result: { ambiguous: true, count: matches.length },
        text: `I found ${matches.length} matching alarms: ${list}. Ask the user which one to delete, then call delete_alarm again with that alarm_id.`,
      };
    }

    const target = matches[0];
    const when = target.fires_at ? fmtAlarmTime(new Date(target.fires_at), tz, lang) : 'unscheduled';
    if (args.confirm !== true) {
      return {
        ok: true,
        result: { needs_confirmation: true, alarm_id: target.id },
        text: `Found the alarm at ${when}${target.label ? ` — "${target.label}"` : ''}. Ask the user to confirm the deletion, then call delete_alarm again with alarm_id="${target.id}" and confirm=true.`,
      };
    }

    const { data: cancelled, error: cancelError } = await sb
      .from(CLOCK_TABLE)
      .update({ status: 'cancelled' })
      .eq('id', target.id)
      .eq('user_id', id.user_id)
      .eq('status', 'active')
      .select('id')
      .maybeSingle();
    if (cancelError) throw new Error(cancelError.message);
    if (!cancelled) return { ok: false, error: 'Alarm was already cancelled or no longer exists.' };

    return {
      ok: true,
      result: { alarm_id: target.id, status: 'cancelled' },
      text: `Deleted the alarm at ${when}${target.label ? ` — "${target.label}"` : ''}.`,
    };
  } catch (err: any) {
    return { ok: false, error: `delete_alarm failed: ${err?.message || 'unknown error'}` };
  }
}

export async function tool_start_timer(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'start_timer requires an authenticated user.' };
  try {
    const minutes = Number(args.duration_minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      return { ok: false, error: 'start_timer needs duration_minutes between 1 and 1440.' };
    }
    const label = strArg(args, 'label') || null;
    const firesAt = new Date(Date.now() + minutes * 60_000);

    const { data, error } = await sb
      .from(CLOCK_TABLE)
      .insert({
        tenant_id: id.tenant_id ?? null,
        user_id: id.user_id,
        kind: 'timer',
        label,
        fires_at: firesAt.toISOString(),
        duration_seconds: Math.round(minutes * 60),
        status: 'active',
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    const row = data as VoiceClockItemRow;
    const mins = Math.round(minutes);
    return {
      ok: true,
      result: { timer_id: row.id, fires_at: row.fires_at, duration_seconds: row.duration_seconds, label },
      text: `Timer started: ${mins} minute${mins === 1 ? '' : 's'}${label ? ` for "${label}"` : ''}.`,
    };
  } catch (err: any) {
    return { ok: false, error: `start_timer failed: ${err?.message || 'unknown error'}` };
  }
}

export async function tool_start_pomodoro(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'start_pomodoro requires an authenticated user.' };
  try {
    const raw = args.duration_minutes;
    const minutes = raw === undefined || raw === null || raw === '' ? 25 : Number(raw);
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 90) {
      return { ok: false, error: 'start_pomodoro needs duration_minutes between 5 and 90 (default 25).' };
    }
    const label = strArg(args, 'label') || null;
    const firesAt = new Date(Date.now() + minutes * 60_000);

    const { data, error } = await sb
      .from(CLOCK_TABLE)
      .insert({
        tenant_id: id.tenant_id ?? null,
        user_id: id.user_id,
        kind: 'pomodoro',
        label,
        fires_at: firesAt.toISOString(),
        duration_seconds: Math.round(minutes * 60),
        status: 'active',
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    const row = data as VoiceClockItemRow;
    const mins = Math.round(minutes);
    return {
      ok: true,
      result: { pomodoro_id: row.id, fires_at: row.fires_at, duration_seconds: row.duration_seconds, label },
      text: `Pomodoro started: ${mins} minutes of focused work${label ? ` on "${label}"` : ''}. Encourage the user to stay on task until it ends.`,
    };
  } catch (err: any) {
    return { ok: false, error: `start_pomodoro failed: ${err?.message || 'unknown error'}` };
  }
}

export async function tool_list_active_timers(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) return { ok: false, error: 'list_active_timers requires an authenticated user.' };
  try {
    const { data, error } = await sb
      .from(CLOCK_TABLE)
      .select('*')
      .eq('user_id', id.user_id)
      .in('kind', ['timer', 'pomodoro'])
      .eq('status', 'active')
      .order('fires_at', { ascending: true })
      .limit(20);
    if (error) throw new Error(error.message);

    const rows = (data || []) as VoiceClockItemRow[];
    if (rows.length === 0) {
      return { ok: true, result: { count: 0, timers: [] }, text: 'You have no running timers or pomodoros.' };
    }
    const now = Date.now();
    const list = rows
      .map((r, i) => {
        const kindName = r.kind === 'pomodoro' ? 'Pomodoro' : 'Timer';
        const remaining = r.fires_at ? formatRemaining(new Date(r.fires_at).getTime() - now) : 'no end time';
        return `${i + 1}. ${kindName}${r.label ? ` "${r.label}"` : ''} — ${remaining}`;
      })
      .join('; ');
    return {
      ok: true,
      result: {
        count: rows.length,
        timers: rows.map((r) => ({
          timer_id: r.id,
          kind: r.kind,
          label: r.label,
          fires_at: r.fires_at,
          remaining_seconds: r.fires_at ? Math.max(0, Math.round((new Date(r.fires_at).getTime() - now) / 1000)) : null,
        })),
      },
      text: `You have ${rows.length} running: ${list}.`,
    };
  } catch (err: any) {
    return { ok: false, error: `list_active_timers failed: ${err?.message || 'unknown error'}` };
  }
}

// ---------------------------------------------------------------------------
// World clock (no network — Intl only)
// ---------------------------------------------------------------------------

/** Common city name → IANA zone. Lookups are diacritic-insensitive lowercase. */
export const CITY_TIMEZONES: Record<string, string> = {
  berlin: 'Europe/Berlin',
  munich: 'Europe/Berlin',
  muenchen: 'Europe/Berlin',
  hamburg: 'Europe/Berlin',
  frankfurt: 'Europe/Berlin',
  cologne: 'Europe/Berlin',
  koln: 'Europe/Berlin',
  vienna: 'Europe/Vienna',
  wien: 'Europe/Vienna',
  zurich: 'Europe/Zurich',
  geneva: 'Europe/Zurich',
  belgrade: 'Europe/Belgrade',
  beograd: 'Europe/Belgrade',
  'novi sad': 'Europe/Belgrade',
  zagreb: 'Europe/Zagreb',
  sarajevo: 'Europe/Sarajevo',
  ljubljana: 'Europe/Ljubljana',
  london: 'Europe/London',
  dublin: 'Europe/Dublin',
  paris: 'Europe/Paris',
  madrid: 'Europe/Madrid',
  barcelona: 'Europe/Madrid',
  lisbon: 'Europe/Lisbon',
  rome: 'Europe/Rome',
  milan: 'Europe/Rome',
  amsterdam: 'Europe/Amsterdam',
  brussels: 'Europe/Brussels',
  copenhagen: 'Europe/Copenhagen',
  stockholm: 'Europe/Stockholm',
  oslo: 'Europe/Oslo',
  helsinki: 'Europe/Helsinki',
  warsaw: 'Europe/Warsaw',
  prague: 'Europe/Prague',
  budapest: 'Europe/Budapest',
  athens: 'Europe/Athens',
  istanbul: 'Europe/Istanbul',
  moscow: 'Europe/Moscow',
  kyiv: 'Europe/Kyiv',
  'tel aviv': 'Asia/Jerusalem',
  cairo: 'Africa/Cairo',
  johannesburg: 'Africa/Johannesburg',
  dubai: 'Asia/Dubai',
  mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  bangkok: 'Asia/Bangkok',
  singapore: 'Asia/Singapore',
  'hong kong': 'Asia/Hong_Kong',
  shanghai: 'Asia/Shanghai',
  beijing: 'Asia/Shanghai',
  tokyo: 'Asia/Tokyo',
  seoul: 'Asia/Seoul',
  sydney: 'Australia/Sydney',
  melbourne: 'Australia/Melbourne',
  auckland: 'Pacific/Auckland',
  'new york': 'America/New_York',
  'washington': 'America/New_York',
  miami: 'America/New_York',
  boston: 'America/New_York',
  toronto: 'America/Toronto',
  chicago: 'America/Chicago',
  'mexico city': 'America/Mexico_City',
  denver: 'America/Denver',
  'los angeles': 'America/Los_Angeles',
  la: 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  seattle: 'America/Los_Angeles',
  vancouver: 'America/Vancouver',
  'sao paulo': 'America/Sao_Paulo',
  'buenos aires': 'America/Argentina/Buenos_Aires',
};

function normalizeCity(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export async function tool_get_world_time(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  try {
    const location = strArg(args, 'location');
    if (!location) {
      return { ok: false, error: 'get_world_time needs a location — a city name (e.g. Berlin) or IANA timezone (e.g. Europe/Berlin).' };
    }

    const normalized = normalizeCity(location);
    let tz = CITY_TIMEZONES[normalized];
    let displayName = location;
    if (!tz) {
      // Not a known city — accept a valid IANA zone string directly.
      if (isValidTimeZone(location)) {
        tz = location;
      } else {
        return {
          ok: false,
          error: `I don't recognize "${location}". Try a major city (e.g. Berlin, Belgrade, London, New York, Tokyo) or a valid IANA timezone like "Europe/Berlin".`,
        };
      }
      displayName = location.includes('/') ? location.split('/').pop()!.replace(/_/g, ' ') : location;
    }

    const now = new Date();
    const lang = langOf(id);
    const timeStr = fmtInTz(now, tz, { hour: 'numeric', minute: '2-digit' }, lang);
    const dateStr = fmtInTz(now, tz, { weekday: 'long', month: 'long', day: 'numeric' }, lang);
    return {
      ok: true,
      result: { timezone: tz, local_time: timeStr, local_date: dateStr, iso: now.toISOString() },
      text: `It's currently ${timeStr} on ${dateStr} in ${displayName} (${tz}).`,
    };
  } catch (err: any) {
    return { ok: false, error: `get_world_time failed: ${err?.message || 'unknown error'}` };
  }
}

// ---------------------------------------------------------------------------
// Exports for the parent integrator
// ---------------------------------------------------------------------------

export const REMINDERS_CLOCK_TOOL_HANDLERS: Record<string, Handler> = {
  snooze_reminder: tool_snooze_reminder,
  update_reminder: tool_update_reminder,
  acknowledge_reminder: tool_acknowledge_reminder,
  complete_reminder: tool_complete_reminder,
  list_missed_reminders: tool_list_missed_reminders,
  set_alarm: tool_set_alarm,
  list_alarms: tool_list_alarms,
  delete_alarm: tool_delete_alarm,
  start_timer: tool_start_timer,
  start_pomodoro: tool_start_pomodoro,
  list_active_timers: tool_list_active_timers,
  get_world_time: tool_get_world_time,
};

export const REMINDERS_CLOCK_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'snooze_reminder',
    description: [
      'Push an existing reminder out by N minutes (default 10, max 1440).',
      "CALL WHEN the user says 'snooze it', 'remind me again in 15 minutes',",
      "'verschieb die Erinnerung', 'erinnere mich später nochmal'.",
      'Pass reminder_id when known (e.g. a reminder just fired), otherwise',
      'text_query with words from the reminder. If the tool reports multiple',
      'matches, ask the user which one and call again with that reminder_id.',
      'After success, speak the confirmation with the new time from `text`.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        reminder_id: { type: 'string', description: 'UUID of the reminder, if known.' },
        text_query: { type: 'string', description: "Free-text to find the reminder (e.g. 'magnesium')." },
        minutes: { type: 'number', description: 'How many minutes to push it out. 1-1440; 10 if omitted.' },
      },
      required: [],
    },
  },
  {
    name: 'update_reminder',
    description: [
      "Edit an existing reminder's text and/or time.",
      "CALL WHEN the user says 'change my reminder to 9pm', 'make it say X',",
      "'ändere meine Erinnerung', 'verschiebe die Erinnerung auf 21 Uhr'.",
      'Identify via reminder_id or text_query. new_time is an absolute UTC ISO',
      'timestamp YOU compute from their words + timezone (min 60s in future).',
      'If multiple reminders match, ask which one, then call again with the id.',
      'After success, confirm the change using `text`.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        reminder_id: { type: 'string', description: 'UUID of the reminder, if known.' },
        text_query: { type: 'string', description: 'Free-text to find the reminder.' },
        new_text: { type: 'string', description: 'New reminder text (max 200 chars). Also becomes the spoken message.' },
        new_time: { type: 'string', description: 'New absolute UTC ISO 8601 timestamp. Min 60s in the future.' },
      },
      required: [],
    },
  },
  {
    name: 'acknowledge_reminder',
    description: [
      'Mark a fired reminder as heard/acknowledged so it stops being re-delivered.',
      "CALL WHEN the user says 'got it', 'okay, I heard the reminder', 'dismiss it',",
      "'alles klar, habs gehört' after a reminder fired — but the task is NOT done yet.",
      'Use complete_reminder instead when the user actually DID the thing.',
      'Identify via reminder_id (preferred, e.g. from the fire event) or text_query.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        reminder_id: { type: 'string', description: 'UUID of the reminder, if known.' },
        text_query: { type: 'string', description: 'Free-text to find the reminder.' },
      },
      required: [],
    },
  },
  {
    name: 'complete_reminder',
    description: [
      'Mark a reminder as DONE (the user did the thing). Sets status=completed.',
      "CALL WHEN the user says 'done', 'I took my magnesium, check it off',",
      "'erledigt', 'hab ich gemacht' about a reminder.",
      'Identify via reminder_id or text_query. If multiple match, ask which one.',
      'After success, give a short positive confirmation from `text`.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        reminder_id: { type: 'string', description: 'UUID of the reminder, if known.' },
        text_query: { type: 'string', description: 'Free-text to find the reminder.' },
      },
      required: [],
    },
  },
  {
    name: 'list_missed_reminders',
    description: [
      "List reminders that fired but were never acknowledged (the user missed them).",
      "CALL WHEN the user asks 'did I miss anything?', 'what reminders did I miss?',",
      "'habe ich Erinnerungen verpasst?', or at the start of a session catch-up.",
      'Speak each missed reminder with its text and when it fired, then offer to',
      'snooze, complete, or acknowledge them.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_alarm',
    description: [
      'Set a wake-up/clock alarm at a specific time of day (optionally recurring).',
      "CALL WHEN the user says 'wake me at 7', 'set an alarm for 6:30 on weekdays',",
      "'stell einen Wecker auf 7 Uhr', 'weck mich um halb sieben'.",
      "time is 'HH:MM' (24h, interpreted in the given timezone — next occurrence)",
      'or an absolute ISO timestamp. ALWAYS pass the user timezone from context;',
      'UTC is assumed when omitted. recurrence: daily, weekdays, or omit for once.',
      'Prefer alarms for time-of-day wake-ups; use set_reminder for task reminders.',
      'After success, confirm with the day + time from `text`.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'string', description: "'HH:MM' 24h wall-clock time, or absolute ISO 8601 timestamp." },
        label: { type: 'string', description: "Optional label, e.g. 'Gym'." },
        recurrence: { type: 'string', enum: ['daily', 'weekdays'], description: 'Omit for a one-time alarm.' },
        timezone: { type: 'string', description: "User's IANA timezone, e.g. Europe/Berlin. UTC assumed if omitted." },
      },
      required: ['time'],
    },
  },
  {
    name: 'list_alarms',
    description: [
      'List the user\'s active alarms with times and labels.',
      "CALL WHEN the user asks 'what alarms do I have?', 'when is my alarm?',",
      "'welche Wecker habe ich?', or before deleting/changing an alarm.",
      'Pass timezone so times are spoken in local wall-clock time.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: "User's IANA timezone for display. UTC assumed if omitted." },
      },
      required: [],
    },
  },
  {
    name: 'delete_alarm',
    description: [
      'Cancel an alarm. Two-step confirm flow: first call WITHOUT confirm to find',
      'the alarm (by alarm_id, label, or HH:MM time) — the tool answers with the',
      'match and asks you to confirm with the user. After the user explicitly says',
      'yes, call again with that alarm_id and confirm=true.',
      "CALL WHEN the user says 'delete my alarm', 'cancel the 7am alarm',",
      "'lösch den Wecker', 'Wecker ausschalten'.",
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        alarm_id: { type: 'string', description: 'UUID from list_alarms / a previous delete_alarm match.' },
        label: { type: 'string', description: 'Match by label substring instead of id.' },
        time: { type: 'string', description: "Match by 'HH:MM' local time instead of id (pass timezone too)." },
        timezone: { type: 'string', description: "User's IANA timezone for the time match. UTC assumed if omitted." },
        confirm: { type: 'boolean', description: 'true ONLY after the user explicitly confirmed the deletion.' },
      },
      required: [],
    },
  },
  {
    name: 'start_timer',
    description: [
      'Start a countdown timer (1-1440 minutes).',
      "CALL WHEN the user says 'set a timer for 10 minutes', 'timer for the pasta',",
      "'stell einen Timer auf 10 Minuten', 'Countdown 20 Minuten'.",
      'For focused work blocks prefer start_pomodoro. After success, confirm the',
      'duration and label from `text`.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        duration_minutes: { type: 'number', description: 'Countdown length in minutes, 1-1440.' },
        label: { type: 'string', description: "Optional label, e.g. 'Pasta'." },
      },
      required: ['duration_minutes'],
    },
  },
  {
    name: 'start_pomodoro',
    description: [
      'Start a pomodoro focus block (5-90 minutes; 25 if omitted).',
      "CALL WHEN the user says 'start a pomodoro', 'let's do a focus session',",
      "'starte eine Pomodoro-Einheit', '45 Minuten Fokuszeit'.",
      'After success, confirm the length and encourage focused work.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        duration_minutes: { type: 'number', description: 'Work block length in minutes, 5-90. 25 if omitted.' },
        label: { type: 'string', description: "Optional focus topic, e.g. 'Deep work on the report'." },
      },
      required: [],
    },
  },
  {
    name: 'list_active_timers',
    description: [
      'List running timers and pomodoros with the remaining time on each.',
      "CALL WHEN the user asks 'how much time is left?', 'is my timer still running?',",
      "'wie lange läuft mein Timer noch?', 'wie viel Zeit habe ich noch?'.",
      'Speak each entry with its label and remaining time from `text`.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_world_time',
    description: [
      'Get the current local time in a city or IANA timezone (no internet needed).',
      "CALL WHEN the user asks 'what time is it in Tokyo?', 'wie spät ist es in",
      "Belgrad?', 'what's the time in New York right now?'.",
      'location accepts a major city name (Berlin, Belgrade, London, New York,',
      "Tokyo, ...) or any IANA zone like 'Europe/Berlin'. Speak the `text` answer.",
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: "City name or IANA timezone, e.g. 'Berlin' or 'Europe/Berlin'." },
      },
      required: ['location'],
    },
  },
];
