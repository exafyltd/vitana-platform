/**
 * Calendar management voice tools (VTID-02761).
 *
 * Read/write management of the user's Intelligent Calendar (`calendar_events`)
 * beyond the existing search/create tools: reschedule, soft-cancel, mark
 * complete, find a free slot, read one event in detail, and check a proposed
 * window for conflicts. Write paths reuse the canonical calendar-service
 * functions (rescheduleEvent / softDeleteEvent / markEventCompleted /
 * checkConflicts) so business rules (original_start_time preservation,
 * reschedule_count, status transitions) live in exactly one place.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import {
  rescheduleEvent,
  softDeleteEvent,
  markEventCompleted,
  checkConflicts,
} from '../calendar-service';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const EVENT_FIELDS =
  'id, title, description, location, start_time, end_time, event_type, status, ' +
  'completion_status, completed_at, completion_notes, reschedule_count, ' +
  'original_start_time, priority_score, wellness_tags, source_type, role_context';

interface CalendarEventRow {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_time: string;
  end_time: string | null;
  event_type: string;
  status: string;
  completion_status: string | null;
  completed_at: string | null;
  completion_notes: string | null;
  reschedule_count: number;
  original_start_time: string | null;
  priority_score: number;
  wellness_tags: string[] | null;
  source_type: string;
  role_context: string;
}

const DEFAULT_DURATION_MS = 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const WAKE_START_HOUR = 8; // 08:00 user-local
const WAKE_END_HOUR = 22; // 22:00 user-local

function strArg(args: OrbToolArgs, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** timezone arg, falling back to args.user_timezone, then UTC. */
function resolveTimezone(args: OrbToolArgs): string {
  const tz = strArg(args, 'timezone') || strArg(args, 'user_timezone') || 'UTC';
  try {
    // Throws RangeError for unknown IANA names.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function parseIso(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Speakable "Tue, Jul 7, 9:00 AM" in the user's timezone. */
function fmtWhen(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

/** Minutes to ADD to a UTC instant to get wall-clock time in tz. */
function tzOffsetMinutes(tz: string, at: Date): number {
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
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** UTC instant of wall-clock (y, mo(1-12), d, h:mi) in tz. */
function utcFromLocal(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  const offset = tzOffsetMinutes(tz, new Date(guess));
  return guess - offset * 60000;
}

/** Local calendar date (in tz) of a UTC instant. */
function localDateParts(tz: string, at: Date): { y: number; mo: number; d: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) parts[p.type] = p.value;
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day) };
}

type ResolveOutcome =
  | { kind: 'found'; event: CalendarEventRow }
  | { kind: 'ambiguous'; matches: CalendarEventRow[] }
  | { kind: 'none' }
  | { kind: 'error'; message: string };

/**
 * Resolve one calendar event by explicit `event_id` or fuzzy `title_query`
 * (ilike on title, scoped to the user, cancelled excluded on title search).
 * Prefers upcoming events; multiple plausible matches → disambiguation list.
 */
async function resolveEvent(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<ResolveOutcome> {
  const eventId = strArg(args, 'event_id');
  const titleQuery = strArg(args, 'title_query') || strArg(args, 'title');

  if (eventId) {
    const { data, error } = await sb
      .from('calendar_events')
      .select(EVENT_FIELDS)
      .eq('user_id', id.user_id)
      .eq('id', eventId)
      .limit(1);
    if (error) return { kind: 'error', message: error.message };
    const row = (data as unknown as CalendarEventRow[] | null)?.[0];
    return row ? { kind: 'found', event: row } : { kind: 'none' };
  }

  if (!titleQuery) {
    return { kind: 'error', message: 'Provide event_id or title_query to identify the event.' };
  }

  const { data, error } = await sb
    .from('calendar_events')
    .select(EVENT_FIELDS)
    .eq('user_id', id.user_id)
    .neq('status', 'cancelled')
    .ilike('title', `%${titleQuery}%`)
    .order('start_time', { ascending: false })
    .limit(20);
  if (error) return { kind: 'error', message: error.message };

  const matches = ((data as unknown as CalendarEventRow[] | null) ?? [])
    .slice()
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'found', event: matches[0] };

  const nowMs = Date.now();
  const upcoming = matches.filter(
    (e) => new Date(e.end_time ?? e.start_time).getTime() >= nowMs,
  );
  if (upcoming.length === 1) return { kind: 'found', event: upcoming[0] };
  return { kind: 'ambiguous', matches: upcoming.length > 1 ? upcoming : matches };
}

function disambiguationResult(matches: CalendarEventRow[], tz: string): OrbToolResult {
  const listed = matches.slice(0, 5);
  const lines = listed
    .map((e, i) => `${i + 1}) "${e.title}" on ${fmtWhen(e.start_time, tz)}`)
    .join('; ');
  return {
    ok: true,
    result: {
      needs_disambiguation: true,
      matches: listed.map((e) => ({ id: e.id, title: e.title, start_time: e.start_time })),
    },
    text:
      `I found ${matches.length} matching events: ${lines}. ` +
      `Ask the user which one they mean, then call the tool again with that event_id.`,
  };
}

function requireUser(toolName: string, id: OrbToolIdentity): OrbToolResult | null {
  if (!id?.user_id) {
    return { ok: false, error: `${toolName} requires an authenticated user.` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// reschedule_event
// ---------------------------------------------------------------------------

export async function tool_reschedule_event(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = requireUser('reschedule_event', id);
  if (gate) return gate;
  try {
    const tz = resolveTimezone(args);
    const newStart = parseIso(strArg(args, 'new_start'));
    if (!newStart) {
      return { ok: false, error: 'reschedule_event requires new_start as an ISO 8601 timestamp.' };
    }

    const resolved = await resolveEvent(args, id, sb);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return { ok: true, result: { found: false }, text: 'I could not find that event on the calendar.' };
    }
    if (resolved.kind === 'ambiguous') return disambiguationResult(resolved.matches, tz);

    const event = resolved.event;
    const explicitEnd = parseIso(strArg(args, 'new_end'));
    let newEnd: Date;
    if (explicitEnd) {
      newEnd = explicitEnd;
    } else {
      // Keep the event's current duration; fall back to 60 minutes.
      const oldStart = new Date(event.start_time).getTime();
      const oldEnd = event.end_time ? new Date(event.end_time).getTime() : NaN;
      const durationMs =
        Number.isFinite(oldEnd) && oldEnd > oldStart ? oldEnd - oldStart : DEFAULT_DURATION_MS;
      newEnd = new Date(newStart.getTime() + durationMs);
    }
    if (newEnd.getTime() <= newStart.getTime()) {
      return { ok: false, error: 'new_end must be after new_start.' };
    }

    const updated = await rescheduleEvent(
      event.id,
      id.user_id,
      newStart.toISOString(),
      newEnd.toISOString(),
    );
    if (!updated) {
      return { ok: false, error: 'Failed to reschedule the event. Please try again.' };
    }
    return {
      ok: true,
      result: {
        event_id: event.id,
        title: event.title,
        old_start: event.start_time,
        new_start: newStart.toISOString(),
        new_end: newEnd.toISOString(),
      },
      text: `Done — I moved "${event.title}" from ${fmtWhen(event.start_time, tz)} to ${fmtWhen(newStart.toISOString(), tz)}.`,
    };
  } catch (err) {
    return { ok: false, error: `reschedule_event failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// cancel_event
// ---------------------------------------------------------------------------

export async function tool_cancel_event(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = requireUser('cancel_event', id);
  if (gate) return gate;
  try {
    const tz = resolveTimezone(args);
    const resolved = await resolveEvent(args, id, sb);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return { ok: true, result: { found: false }, text: 'I could not find that event on the calendar.' };
    }
    if (resolved.kind === 'ambiguous') return disambiguationResult(resolved.matches, tz);

    const event = resolved.event;
    if (event.status === 'cancelled') {
      return {
        ok: true,
        result: { event_id: event.id, already_cancelled: true },
        text: `"${event.title}" is already cancelled.`,
      };
    }

    if (args.confirm !== true) {
      return {
        ok: true,
        result: {
          needs_confirmation: true,
          event_id: event.id,
          title: event.title,
          start_time: event.start_time,
        },
        text:
          `Found "${event.title}" on ${fmtWhen(event.start_time, tz)}. ` +
          `Ask the user to confirm the cancellation, then call cancel_event again with confirm=true and event_id=${event.id}.`,
      };
    }

    const cancelled = await softDeleteEvent(event.id, id.user_id);
    if (!cancelled) {
      return { ok: false, error: 'Failed to cancel the event. Please try again.' };
    }
    return {
      ok: true,
      result: { event_id: event.id, title: event.title, status: 'cancelled' },
      text: `Cancelled — "${event.title}" on ${fmtWhen(event.start_time, tz)} is off the calendar.`,
    };
  } catch (err) {
    return { ok: false, error: `cancel_event failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// complete_event
// ---------------------------------------------------------------------------

const VALID_OUTCOMES = ['completed', 'skipped', 'partial'] as const;

export async function tool_complete_event(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = requireUser('complete_event', id);
  if (gate) return gate;
  try {
    const tz = resolveTimezone(args);
    const outcome = (strArg(args, 'outcome') || 'completed') as (typeof VALID_OUTCOMES)[number];
    if (!VALID_OUTCOMES.includes(outcome)) {
      return {
        ok: false,
        error: `Invalid outcome "${outcome}". Use one of: ${VALID_OUTCOMES.join(', ')}.`,
      };
    }

    const resolved = await resolveEvent(args, id, sb);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return { ok: true, result: { found: false }, text: 'I could not find that event on the calendar.' };
    }
    if (resolved.kind === 'ambiguous') return disambiguationResult(resolved.matches, tz);

    const event = resolved.event;
    const notes = strArg(args, 'notes') || null;
    const updated = await markEventCompleted(event.id, id.user_id, outcome, notes);
    if (!updated) {
      return { ok: false, error: 'Failed to update the event. Please try again.' };
    }

    const spokenOutcome =
      outcome === 'completed'
        ? 'marked as completed'
        : outcome === 'skipped'
          ? 'marked as skipped'
          : 'marked as partially done';
    return {
      ok: true,
      result: { event_id: event.id, title: event.title, completion_status: outcome },
      text: `Nice — "${event.title}" (${fmtWhen(event.start_time, tz)}) is ${spokenOutcome}.`,
    };
  } catch (err) {
    return { ok: false, error: `complete_event failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// find_free_slot
// ---------------------------------------------------------------------------

export async function tool_find_free_slot(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = requireUser('find_free_slot', id);
  if (gate) return gate;
  try {
    const duration = Math.round(Number(args.duration_minutes));
    if (!Number.isFinite(duration) || duration < 5 || duration > 720) {
      return {
        ok: false,
        error: 'find_free_slot requires duration_minutes between 5 and 720.',
      };
    }
    const durationMs = duration * 60000;
    const tz = resolveTimezone(args);

    const now = new Date();
    const from = parseIso(strArg(args, 'search_from')) ?? now;
    const defaultTo = new Date(from.getTime() + 7 * 86400000);
    let to = parseIso(strArg(args, 'search_to')) ?? defaultTo;
    const maxTo = new Date(from.getTime() + 30 * 86400000);
    if (to.getTime() > maxTo.getTime()) to = maxTo;
    if (to.getTime() <= from.getTime()) {
      return { ok: false, error: 'search_to must be after search_from.' };
    }

    // Busy intervals: non-cancelled events overlapping the window.
    const { data, error } = await sb
      .from('calendar_events')
      .select('id, title, start_time, end_time, status')
      .eq('user_id', id.user_id)
      .neq('status', 'cancelled')
      .lt('start_time', to.toISOString())
      .gt('end_time', from.toISOString())
      .order('start_time', { ascending: true })
      .limit(500);
    if (error) return { ok: false, error: `find_free_slot failed: ${error.message}` };

    const busy = ((data as Array<{ start_time: string; end_time: string | null }> | null) ?? [])
      .filter((e) => e.end_time)
      .map((e) => ({
        start: new Date(e.start_time).getTime(),
        end: new Date(e.end_time as string).getTime(),
      }))
      .sort((a, b) => a.start - b.start);
    // Merge overlapping busy intervals.
    const merged: Array<{ start: number; end: number }> = [];
    for (const b of busy) {
      const last = merged[merged.length - 1];
      if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
      else merged.push({ ...b });
    }

    const roundUp15 = (ms: number) => Math.ceil(ms / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;
    const earliestMs = Math.max(from.getTime(), now.getTime());

    let slotStartMs: number | null = null;
    const totalDays = Math.ceil((to.getTime() - from.getTime()) / 86400000) + 1;
    for (let day = 0; day < totalDays && slotStartMs === null; day++) {
      const probe = new Date(from.getTime() + day * 86400000);
      const { y, mo, d } = localDateParts(tz, probe);
      const windowStart = utcFromLocal(tz, y, mo, d, WAKE_START_HOUR, 0);
      const windowEnd = utcFromLocal(tz, y, mo, d, WAKE_END_HOUR, 0);
      const effEnd = Math.min(windowEnd, to.getTime());
      let cursor = roundUp15(Math.max(windowStart, earliestMs));

      for (const b of merged) {
        if (b.end <= cursor) continue;
        if (b.start >= effEnd) break;
        if (b.start - cursor >= durationMs) break; // gap before this busy block fits
        cursor = roundUp15(Math.max(cursor, b.end));
      }
      if (cursor + durationMs <= effEnd) slotStartMs = cursor;
    }

    if (slotStartMs === null) {
      return {
        ok: true,
        result: { slot_found: false, duration_minutes: duration },
        text:
          `I couldn't find a free ${duration}-minute slot between ` +
          `${fmtWhen(from.toISOString(), tz)} and ${fmtWhen(to.toISOString(), tz)} ` +
          `within waking hours (8 AM to 10 PM). Want me to look further out?`,
      };
    }

    const slotStartIso = new Date(slotStartMs).toISOString();
    const slotEndIso = new Date(slotStartMs + durationMs).toISOString();
    return {
      ok: true,
      result: {
        slot_found: true,
        slot_start: slotStartIso,
        slot_end: slotEndIso,
        duration_minutes: duration,
        timezone: tz,
      },
      text: `You're free for ${duration} minutes on ${fmtWhen(slotStartIso, tz)} (until ${fmtWhen(slotEndIso, tz)}).`,
    };
  } catch (err) {
    return { ok: false, error: `find_free_slot failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// get_event_details
// ---------------------------------------------------------------------------

export async function tool_get_event_details(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = requireUser('get_event_details', id);
  if (gate) return gate;
  try {
    const tz = resolveTimezone(args);
    const resolved = await resolveEvent(args, id, sb);
    if (resolved.kind === 'error') return { ok: false, error: resolved.message };
    if (resolved.kind === 'none') {
      return {
        ok: true,
        result: { found: false },
        text: 'I could not find a matching event on the calendar.',
      };
    }
    if (resolved.kind === 'ambiguous') return disambiguationResult(resolved.matches, tz);

    const e = resolved.event;
    const bits: string[] = [`"${e.title}" is on ${fmtWhen(e.start_time, tz)}`];
    if (e.end_time) bits.push(`until ${fmtWhen(e.end_time, tz)}`);
    if (e.location) bits.push(`at ${e.location}`);
    bits.push(`(${e.event_type}, status ${e.status}`);
    let tail = ')';
    if (e.completion_status) tail = `, ${e.completion_status})`;
    const desc = e.description ? ` Notes: ${String(e.description).slice(0, 200)}` : '';
    return {
      ok: true,
      result: { found: true, event: e },
      text: `${bits.join(' ')}${tail}.${desc}`,
    };
  } catch (err) {
    return { ok: false, error: `get_event_details failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// check_calendar_conflicts
// ---------------------------------------------------------------------------

export async function tool_check_calendar_conflicts(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = requireUser('check_calendar_conflicts', id);
  if (gate) return gate;
  try {
    const tz = resolveTimezone(args);
    const start = parseIso(strArg(args, 'start_time') || strArg(args, 'proposed_start'));
    if (!start) {
      return {
        ok: false,
        error: 'check_calendar_conflicts requires start_time as an ISO 8601 timestamp.',
      };
    }
    const end =
      parseIso(strArg(args, 'end_time') || strArg(args, 'proposed_end')) ??
      new Date(start.getTime() + DEFAULT_DURATION_MS);
    if (end.getTime() <= start.getTime()) {
      return { ok: false, error: 'end_time must be after start_time.' };
    }

    const conflicts = await checkConflicts(
      id.user_id,
      id.role ?? 'community',
      start.toISOString(),
      end.toISOString(),
    );

    if (conflicts.length === 0) {
      return {
        ok: true,
        result: { has_conflicts: false, conflicts: [] },
        text: `That window (${fmtWhen(start.toISOString(), tz)} to ${fmtWhen(end.toISOString(), tz)}) is free — no conflicts.`,
      };
    }

    const lines = conflicts
      .slice(0, 5)
      .map((c) => `"${c.title}" at ${fmtWhen(c.start_time, tz)}`)
      .join('; ');
    return {
      ok: true,
      result: {
        has_conflicts: true,
        conflicts: conflicts.map((c) => ({
          id: c.id,
          title: c.title,
          start_time: c.start_time,
          end_time: c.end_time,
        })),
      },
      text: `That overlaps with ${conflicts.length} event${conflicts.length === 1 ? '' : 's'}: ${lines}. Want a different time?`,
    };
  } catch (err) {
    return { ok: false, error: `check_calendar_conflicts failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const CALENDAR_MGMT_TOOL_HANDLERS: Record<string, Handler> = {
  reschedule_event: tool_reschedule_event,
  cancel_event: tool_cancel_event,
  complete_event: tool_complete_event,
  find_free_slot: tool_find_free_slot,
  get_event_details: tool_get_event_details,
  check_calendar_conflicts: tool_check_calendar_conflicts,
};

export const CALENDAR_MGMT_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'reschedule_event',
    description: [
      'Move an existing calendar event to a new start time (duration is kept unless new_end is given).',
      'WHEN TO CALL: "move my yoga to 6 pm", "reschedule my doctor appointment to Friday",',
      '"Verschieb mein Meeting auf morgen 10 Uhr", "Kannst du das Training auf Freitag legen?".',
      'Identify the event by event_id (preferred) or title_query (fuzzy title match).',
      'If multiple events match, the result lists candidates — ask the user which one, then call again with event_id.',
      'After success, confirm the new day and time back to the user.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Exact calendar event id (UUID), if known.' },
        title_query: {
          type: 'string',
          description: 'Fuzzy title to find the event, e.g. "yoga" or "dentist". Use when event_id is unknown.',
        },
        new_start: { type: 'string', description: 'New start time, ISO 8601 (e.g. "2026-07-10T18:00:00Z").' },
        new_end: {
          type: 'string',
          description: 'Optional new end time, ISO 8601. Omit to keep the original duration.',
        },
        timezone: { type: 'string', description: 'IANA timezone for spoken times, e.g. "Europe/Berlin".' },
      },
      required: ['new_start'],
    },
  },
  {
    name: 'cancel_event',
    description: [
      'Cancel (soft-delete) a calendar event — the event stays in history with status "cancelled".',
      'WHEN TO CALL: "cancel my yoga class", "delete the dentist appointment",',
      '"Sag das Meeting morgen ab", "Lösch den Termin am Freitag".',
      'Destructive: first call WITHOUT confirm to fetch the event, ask the user to confirm,',
      'then call again with confirm=true and the event_id. Speak the cancelled title back.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Exact calendar event id (UUID), if known.' },
        title_query: { type: 'string', description: 'Fuzzy title to find the event when event_id is unknown.' },
        confirm: {
          type: 'boolean',
          description: 'Set true ONLY after the user has verbally confirmed the cancellation.',
        },
        timezone: { type: 'string', description: 'IANA timezone for spoken times.' },
      },
      required: [],
    },
  },
  {
    name: 'complete_event',
    description: [
      'Mark a calendar event as completed, skipped, or partially done.',
      'WHEN TO CALL: "I finished my workout", "mark the meditation as done", "I skipped my run today",',
      '"Ich habe das Training gemacht", "Hab die Meditation ausgelassen".',
      'outcome must be one of: completed, skipped, partial (default completed).',
      'After success, acknowledge briefly — completed health events feed the Vitana Index.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Exact calendar event id (UUID), if known.' },
        title_query: { type: 'string', description: 'Fuzzy title to find the event when event_id is unknown.' },
        outcome: { type: 'string', description: 'One of: completed, skipped, partial. Defaults to completed.' },
        notes: { type: 'string', description: 'Optional short completion note from the user.' },
        timezone: { type: 'string', description: 'IANA timezone for spoken times.' },
      },
      required: [],
    },
  },
  {
    name: 'find_free_slot',
    description: [
      'Find the next free slot of a given length in the user\'s calendar, within waking hours (8 AM-10 PM user-local).',
      'WHEN TO CALL: "when am I free for an hour?", "find me 30 minutes tomorrow",',
      '"Wann habe ich morgen Zeit?", "Finde mir eine freie Stunde diese Woche".',
      'duration_minutes is required (5-720). search_from/search_to are ISO 8601; default is the next 7 days.',
      'Pass the user\'s IANA timezone so waking hours and spoken times are local.',
      'Speak the found day + time back, or say nothing was free and offer to look further out.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        duration_minutes: { type: 'number', description: 'Required slot length in minutes (5 to 720).' },
        search_from: { type: 'string', description: 'Optional ISO 8601 start of the search window. Defaults to now.' },
        search_to: {
          type: 'string',
          description: 'Optional ISO 8601 end of the search window. Defaults to 7 days after search_from (max 30).',
        },
        timezone: { type: 'string', description: 'IANA timezone, e.g. "Europe/Berlin". Defaults to UTC.' },
      },
      required: ['duration_minutes'],
    },
  },
  {
    name: 'get_event_details',
    description: [
      'Read the full details of ONE calendar event: exact time, end, location, type, status, notes.',
      'WHEN TO CALL: "when exactly is my dentist appointment?", "where is the meetup?",',
      '"Wann genau ist mein Zahnarzttermin?", "Wo findet das Treffen statt?".',
      'Identify by event_id or title_query (fuzzy). If several match, the result lists candidates — ask which one.',
      'Speak the concrete details (day, time, place); never a raw data dump.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Exact calendar event id (UUID), if known.' },
        title_query: { type: 'string', description: 'Fuzzy title to find the event when event_id is unknown.' },
        timezone: { type: 'string', description: 'IANA timezone for spoken times.' },
      },
      required: [],
    },
  },
  {
    name: 'check_calendar_conflicts',
    description: [
      'Check whether a proposed time window overlaps existing confirmed calendar events.',
      'WHEN TO CALL: before creating or rescheduling an event, or when the user asks',
      '"does 3 pm work on Friday?", "Passt Dienstag 10 Uhr?", "Habe ich da schon etwas?".',
      'start_time is required (ISO 8601); end_time defaults to one hour after start_time.',
      'If there are conflicts, name the overlapping events and suggest checking another time.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        start_time: { type: 'string', description: 'Proposed start, ISO 8601 (e.g. "2026-07-10T15:00:00Z").' },
        end_time: { type: 'string', description: 'Proposed end, ISO 8601. Defaults to 1 hour after start_time.' },
        timezone: { type: 'string', description: 'IANA timezone for spoken times.' },
      },
      required: ['start_time'],
    },
  },
];
