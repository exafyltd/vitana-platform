/**
 * Intelligent Calendar — Core Service
 *
 * Server-side calendar CRUD with role-based filtering.
 * All queries use PostgREST via SUPABASE_URL + SUPABASE_SERVICE_ROLE,
 * following the same pattern as autopilot-recommendations.ts.
 *
 * The calendar is the 4th pillar of infinite memory — events are never
 * deleted, only status-transitioned. Every completion/skip/reschedule
 * is permanent learning data.
 */

import {
  CalendarEvent,
  CalendarEventSummary,
  CreateCalendarEventInput,
  getVisibleContexts,
} from '../types/calendar';
import { localParts, zonedTimeToEpoch } from './calendar-recurrence';
import { quietWindowFromPrefs, type QuietWindow } from './calendar-reminders';

const LOG_PREFIX = '[Calendar]';

// =============================================================================
// Supabase helpers
// =============================================================================

export function getSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    console.warn(`${LOG_PREFIX} Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE`);
    return null;
  }
  return { url, key };
}

export function headers(key: string, extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// =============================================================================
// Role filter helper
// =============================================================================

/**
 * Build PostgREST filter string for role_context.
 * Returns null if no filter needed (super_admin).
 */
function roleFilter(role: string | null): string | null {
  const contexts = getVisibleContexts(role);
  if (!contexts) return null; // super_admin
  return `role_context=in.(${contexts.join(',')})`;
}

// =============================================================================
// Read operations
// =============================================================================

export async function getUserUpcomingEvents(
  userId: string,
  role: string | null,
  limit: number = 20,
): Promise<CalendarEvent[]> {
  const config = getSupabaseConfig();
  if (!config) return [];

  const now = new Date().toISOString();
  let url = `${config.url}/rest/v1/calendar_events?user_id=eq.${userId}&status=neq.cancelled&start_time=gte.${now}&order=start_time.asc&limit=${limit}`;

  const rf = roleFilter(role);
  if (rf) url += `&${rf}`;

  const resp = await fetch(url, { headers: headers(config.key) });
  if (!resp.ok) {
    console.error(`${LOG_PREFIX} getUserUpcomingEvents failed:`, await resp.text());
    return [];
  }
  return resp.json() as Promise<any>;
}

export async function getUserTodayEvents(
  userId: string,
  role: string | null,
  timezone: string = 'UTC',
): Promise<CalendarEvent[]> {
  const config = getSupabaseConfig();
  if (!config) return [];

  // Calculate today's boundaries in the user's timezone
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  let url = `${config.url}/rest/v1/calendar_events?user_id=eq.${userId}&status=neq.cancelled&start_time=gte.${todayStart.toISOString()}&start_time=lte.${todayEnd.toISOString()}&order=start_time.asc`;

  const rf = roleFilter(role);
  if (rf) url += `&${rf}`;

  const resp = await fetch(url, { headers: headers(config.key) });
  if (!resp.ok) {
    console.error(`${LOG_PREFIX} getUserTodayEvents failed:`, await resp.text());
    return [];
  }
  return resp.json() as Promise<any>;
}

export async function getUserCalendarHistory(
  userId: string,
  role: string | null,
  daysBack: number = 30,
  limit: number = 100,
): Promise<CalendarEvent[]> {
  const config = getSupabaseConfig();
  if (!config) return [];

  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  let url = `${config.url}/rest/v1/calendar_events?user_id=eq.${userId}&start_time=gte.${since}&start_time=lte.${now}&order=start_time.desc&limit=${limit}`;

  const rf = roleFilter(role);
  if (rf) url += `&${rf}`;

  const resp = await fetch(url, { headers: headers(config.key) });
  if (!resp.ok) {
    console.error(`${LOG_PREFIX} getUserCalendarHistory failed:`, await resp.text());
    return [];
  }
  return resp.json() as Promise<any>;
}

export async function getEventsBySourceRef(
  userId: string,
  sourceRefId: string,
): Promise<CalendarEvent[]> {
  const config = getSupabaseConfig();
  if (!config) return [];

  const url = `${config.url}/rest/v1/calendar_events?user_id=eq.${userId}&source_ref_id=eq.${sourceRefId}&limit=5`;
  const resp = await fetch(url, { headers: headers(config.key) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error(`${LOG_PREFIX} getEventsBySourceRef failed (${resp.status}):`, errText);
    return [];
  }
  return resp.json() as Promise<any>;
}

export async function checkConflicts(
  userId: string,
  role: string | null,
  startTime: string,
  endTime: string,
): Promise<CalendarEvent[]> {
  const config = getSupabaseConfig();
  if (!config) return [];

  // Events that overlap: event.start < proposed.end AND event.end > proposed.start
  let url = `${config.url}/rest/v1/calendar_events?user_id=eq.${userId}&status=eq.confirmed&start_time=lt.${endTime}&end_time=gt.${startTime}&order=start_time.asc`;

  const rf = roleFilter(role);
  if (rf) url += `&${rf}`;

  const resp = await fetch(url, { headers: headers(config.key) });
  if (!resp.ok) return [];
  return resp.json() as Promise<any>;
}

// =============================================================================
// VTID-04995 — overlap warnings
// =============================================================================

export type ConflictKind = 'own' | 'busy' | 'external';

/** One thing a proposed time overlaps. Busy/external carry no title, on purpose. */
export interface ConflictItem {
  kind: ConflictKind;
  id: string;
  event_id: string;
  title: string | null;
  start_time: string;
  end_time: string;
  source?: string;
}

/** Entries the system writes as information, not as time the member has committed. */
const NON_COMMITMENT_SOURCES = new Set(['reminder', 'subscription']);
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface ExternalBusyLike {
  id: string;
  event_id: string;
  start_time: string;
  end_time: string;
  source?: string;
}

/**
 * Pure: what a proposed [start, end) overlaps, given what the calendar screen
 * shows (window items: own entries with recurrence expanded, other lenses as
 * title-less busy blocks) and the member's external busy times.
 *  - own: the member's confirmed entries in the active lens (title included)
 *  - busy: another lens of the same member (time only)
 *  - external: a busy block from a connected calendar (time only)
 * Reminders and subscription dates never conflict; `excludeEventId` is the
 * entry being edited or moved (all its occurrences).
 */
export function computeConflicts(
  items: CalendarWindowItem[],
  external: ExternalBusyLike[],
  proposed: { start: string; end: string },
  opts: { excludeEventId?: string } = {},
): ConflictItem[] {
  const pStart = Date.parse(proposed.start);
  const pEnd = Date.parse(proposed.end);
  if (Number.isNaN(pStart) || Number.isNaN(pEnd) || pEnd <= pStart) return [];

  const overlaps = (start: string, end: string | null): { start: number; end: number } | null => {
    const s = Date.parse(start);
    if (Number.isNaN(s)) return null;
    const parsedEnd = end ? Date.parse(end) : NaN;
    const e = Number.isNaN(parsedEnd) ? s + ONE_HOUR_MS : parsedEnd;
    return s < pEnd && e > pStart ? { start: s, end: e } : null;
  };

  const out: ConflictItem[] = [];
  for (const it of items) {
    if (opts.excludeEventId && it.event_id === opts.excludeEventId) continue;
    const hit = overlaps(it.start_time, it.end_time);
    if (!hit) continue;
    if (it.busy || !it.event) {
      out.push({ kind: 'busy', id: it.id, event_id: it.event_id, title: null, start_time: new Date(hit.start).toISOString(), end_time: new Date(hit.end).toISOString() });
      continue;
    }
    if (it.event.status !== 'confirmed') continue;
    if (NON_COMMITMENT_SOURCES.has(String(it.event.source_type))) continue;
    out.push({ kind: 'own', id: it.id, event_id: it.event_id, title: it.event.title ?? null, start_time: new Date(hit.start).toISOString(), end_time: new Date(hit.end).toISOString() });
  }
  for (const x of external) {
    const hit = overlaps(x.start_time, x.end_time);
    if (!hit) continue;
    out.push({ kind: 'external', id: x.id, event_id: x.event_id, title: null, start_time: new Date(hit.start).toISOString(), end_time: new Date(hit.end).toISOString(), source: x.source });
  }
  return out.sort((a, b) => a.start_time.localeCompare(b.start_time)).slice(0, 20);
}

/**
 * Overlaps for a proposed window, composed exactly like the calendar screen:
 * the window read plus the external busy blocks the window route adds on top.
 */
export async function findConflicts(
  userId: string,
  role: string | null,
  startTime: string,
  endTime: string,
  opts: { excludeEventId?: string; userTimezone?: string } = {},
): Promise<ConflictItem[]> {
  const window = { from: startTime, to: endTime };
  const { listExternalBusy } = await import('./calendar-google-sync');
  const [items, external] = await Promise.all([
    listCalendarWindow(userId, role, window, { includeBusy: true, userTimezone: opts.userTimezone }),
    listExternalBusy(userId, window),
  ]);
  return computeConflicts(items, external, { start: startTime, end: endTime }, { excludeEventId: opts.excludeEventId });
}

/**
 * Find calendar gaps (free time slots) for a given day.
 */
export async function getCalendarGaps(
  userId: string,
  role: string | null,
  date: Date,
): Promise<{ start: string; end: string; duration_minutes: number }[]> {
  const dayStart = new Date(date);
  dayStart.setHours(7, 0, 0, 0); // Assume day starts at 7am
  const dayEnd = new Date(date);
  dayEnd.setHours(22, 0, 0, 0); // Assume day ends at 10pm

  const events = await getUserTodayEvents(userId, role);
  const sorted = events
    .filter(e => e.end_time)
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  const gaps: { start: string; end: string; duration_minutes: number }[] = [];
  let cursor = dayStart.getTime();

  for (const event of sorted) {
    const evStart = new Date(event.start_time).getTime();
    const evEnd = new Date(event.end_time!).getTime();

    if (evStart > cursor) {
      const durationMin = Math.round((evStart - cursor) / 60000);
      if (durationMin >= 15) { // Only gaps >= 15 minutes
        gaps.push({
          start: new Date(cursor).toISOString(),
          end: new Date(evStart).toISOString(),
          duration_minutes: durationMin,
        });
      }
    }
    cursor = Math.max(cursor, evEnd);
  }

  // Trailing gap until end of day
  if (cursor < dayEnd.getTime()) {
    const durationMin = Math.round((dayEnd.getTime() - cursor) / 60000);
    if (durationMin >= 15) {
      gaps.push({
        start: new Date(cursor).toISOString(),
        end: dayEnd.toISOString(),
        duration_minutes: durationMin,
      });
    }
  }

  return gaps;
}

// =============================================================================
// Find a time (VTID-04996)
// =============================================================================

export interface FreeSlot {
  start: string;
  end: string;
  duration_minutes: number;
  /** How long the free stretch this slot starts in lasts, so the UI can say "free until". */
  free_until: string;
}

const SLOT_STEP_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const FREE_SLOT_MAX_DAYS = 14;
export const FREE_SLOT_DEFAULT_DAY: QuietWindow = { startMin: 22 * 60, endMin: 7 * 60 };

/** Awake spans of a local day, as [fromMin, toMin) pairs, given the member's quiet window. Pure. */
export function awakeSpans(quiet: QuietWindow | null): Array<[number, number]> {
  const q = quiet ?? FREE_SLOT_DEFAULT_DAY;
  if (q.startMin > q.endMin) return [[q.endMin, q.startMin]]; // wraps midnight: quiet 22:00-07:00 → awake 07:00-22:00
  return [[0, q.startMin], [q.endMin, 24 * 60]].filter(([a, b]) => b > a) as Array<[number, number]>;
}

/**
 * Free stretches that fit `durationMin`, composed like the calendar screen:
 * window items (own commitments, other lenses as busy) plus external busy,
 * inside the member's waking hours (outside quiet hours; 07:00-22:00 when none
 * are set), in the member's time zone. One slot per free stretch, starting on
 * the next quarter hour. Pure; `now` only trims the past.
 */
export function computeFreeSlots(
  items: CalendarWindowItem[],
  external: ExternalBusyLike[],
  opts: {
    from: number;
    to: number;
    durationMin: number;
    limit: number;
    tz: string;
    quiet: QuietWindow | null;
    now: number;
    excludeEventId?: string;
  },
): FreeSlot[] {
  const durMs = opts.durationMin * 60_000;
  if (!(durMs > 0) || !(opts.to > opts.from) || opts.to - opts.from > FREE_SLOT_MAX_DAYS * DAY_MS) return [];

  const busy: Array<[number, number]> = [];
  const push = (start: string, end: string | null) => {
    const s = Date.parse(start);
    if (Number.isNaN(s)) return;
    const parsedEnd = end ? Date.parse(end) : NaN;
    busy.push([s, Number.isNaN(parsedEnd) ? s + ONE_HOUR_MS : parsedEnd]);
  };
  for (const it of items) {
    if (opts.excludeEventId && it.event_id === opts.excludeEventId) continue;
    if (it.busy || !it.event) {
      push(it.start_time, it.end_time);
      continue;
    }
    if (it.event.status !== 'confirmed' || NON_COMMITMENT_SOURCES.has(String(it.event.source_type))) continue;
    push(it.start_time, it.end_time);
  }
  for (const x of external) push(x.start_time, x.end_time);
  busy.sort((a, b) => a[0] - b[0]);

  const floor = Math.ceil(Math.max(opts.from, opts.now) / SLOT_STEP_MS) * SLOT_STEP_MS;
  const spans = awakeSpans(opts.quiet);
  const first = localParts(opts.from, opts.tz);
  const out: FreeSlot[] = [];

  for (let day = 0; day <= FREE_SLOT_MAX_DAYS && out.length < opts.limit; day++) {
    const base = new Date(Date.UTC(first.y, first.mo - 1, first.d + day));
    const y = base.getUTCFullYear();
    const mo = base.getUTCMonth() + 1;
    const d = base.getUTCDate();
    for (const [a, b] of spans) {
      let cursor = Math.max(zonedTimeToEpoch(y, mo, d, Math.floor(a / 60), a % 60, 0, opts.tz), floor);
      const end = Math.min(b >= 24 * 60 ? zonedTimeToEpoch(y, mo, d + 1, 0, 0, 0, opts.tz) : zonedTimeToEpoch(y, mo, d, Math.floor(b / 60), b % 60, 0, opts.tz), opts.to);
      if (end <= cursor) continue;
      // Walk the free stretches between busy intervals inside [cursor, end).
      for (const [bs, be] of busy) {
        if (be <= cursor) continue;
        if (bs >= end) break;
        if (bs > cursor) {
          const slot = tryFreeSlot(cursor, Math.min(bs, end), durMs, opts.durationMin);
          if (slot) out.push(slot);
        }
        cursor = Math.max(cursor, be);
        if (cursor >= end) break;
      }
      if (cursor < end) {
        const slot = tryFreeSlot(cursor, end, durMs, opts.durationMin);
        if (slot) out.push(slot);
      }
      if (out.length >= opts.limit) break;
    }
  }
  return out.sort((x, y) => x.start.localeCompare(y.start)).slice(0, opts.limit);
}

function tryFreeSlot(from: number, until: number, durMs: number, durationMin: number): FreeSlot | null {
  const start = Math.ceil(from / SLOT_STEP_MS) * SLOT_STEP_MS;
  if (start + durMs > until) return null;
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + durMs).toISOString(),
    duration_minutes: durationMin,
    free_until: new Date(until).toISOString(),
  };
}

/** The member's quiet window (notification Do-Not-Disturb), or null when off or unreadable. */
export async function loadQuietWindow(userId: string): Promise<QuietWindow | null> {
  const config = getSupabaseConfig();
  if (!config) return null;
  try {
    const r = await fetch(
      `${config.url}/rest/v1/user_notification_preferences?select=dnd_enabled,dnd_start_time,dnd_end_time&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
      { headers: headers(config.key) },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{ dnd_enabled?: boolean; dnd_start_time?: string | null; dnd_end_time?: string | null }>;
    return quietWindowFromPrefs(rows[0]);
  } catch {
    return null;
  }
}

/** Free slots for a member, composed exactly like the calendar screen plus their quiet hours. */
export async function findFreeSlots(
  userId: string,
  role: string | null,
  opts: { from: Date; to: Date; durationMin: number; limit: number; userTimezone?: string },
): Promise<FreeSlot[]> {
  const window = { from: opts.from.toISOString(), to: opts.to.toISOString() };
  const { listExternalBusy } = await import('./calendar-google-sync');
  const [items, external, quiet] = await Promise.all([
    listCalendarWindow(userId, role, window, { includeBusy: true, userTimezone: opts.userTimezone }),
    listExternalBusy(userId, window),
    loadQuietWindow(userId),
  ]);
  return computeFreeSlots(items, external, {
    from: opts.from.getTime(),
    to: opts.to.getTime(),
    durationMin: opts.durationMin,
    limit: opts.limit,
    tz: opts.userTimezone || 'Europe/Berlin',
    quiet,
    now: Date.now(),
  });
}

/**
 * Find next available slot for a given duration.
 * Looks for gaps today first, then tomorrow morning if none found.
 */
export async function computeNextAvailableSlot(
  userId: string,
  role: string | null,
  durationMinutes: number,
): Promise<Date> {
  const now = new Date();

  // Try today first
  const gapsToday = await getCalendarGaps(userId, role, now);
  for (const gap of gapsToday) {
    const gapStart = new Date(gap.start);
    // Only consider gaps that start in the future
    if (gapStart > now && gap.duration_minutes >= durationMinutes) {
      // Round up to next 15-minute boundary
      const minutes = gapStart.getMinutes();
      const rounded = Math.ceil(minutes / 15) * 15;
      gapStart.setMinutes(rounded, 0, 0);
      return gapStart;
    }
  }

  // No gap today → schedule for tomorrow at 9am
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow;
}

// =============================================================================
// Write operations
// =============================================================================

export async function createCalendarEvent(
  userId: string,
  input: CreateCalendarEventInput,
  // Optional error sink — receives the raw PostgREST error body when the insert
  // fails. Lets callers surface WHY a write failed (previously only console.error'd
  // to Cloud Run logs) so failures are diagnosable in telemetry / the self-check.
  onError?: (message: string) => void,
): Promise<CalendarEvent | null> {
  const config = getSupabaseConfig();
  if (!config) {
    if (onError) onError('supabase_config_missing');
    return null;
  }

  const body = {
    user_id: userId,
    ...input,
  };

  const resp = await fetch(`${config.url}/rest/v1/calendar_events`, {
    method: 'POST',
    headers: headers(config.key, { Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`${LOG_PREFIX} createCalendarEvent failed:`, errText);
    if (onError) onError(`${resp.status}: ${errText}`.slice(0, 300));
    return null;
  }

  const rows = await resp.json() as CalendarEvent[];
  return rows[0] ?? null;
}

export async function bulkCreateCalendarEvents(
  userId: string,
  inputs: CreateCalendarEventInput[],
): Promise<CalendarEvent[]> {
  const config = getSupabaseConfig();
  if (!config || inputs.length === 0) return [];

  const bodies = inputs.map(input => ({
    user_id: userId,
    ...input,
  }));

  const resp = await fetch(`${config.url}/rest/v1/calendar_events`, {
    method: 'POST',
    headers: headers(config.key, { Prefer: 'return=representation' }),
    body: JSON.stringify(bodies),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`${LOG_PREFIX} bulkCreateCalendarEvents failed (${resp.status}): ${errText}`);
    console.error(`${LOG_PREFIX} First event payload:`, JSON.stringify(bodies[0]).slice(0, 500));
    return [];
  }

  return resp.json() as Promise<any>;
}

export async function updateCalendarEvent(
  eventId: string,
  userId: string,
  updates: Record<string, unknown>,
): Promise<CalendarEvent | null> {
  const config = getSupabaseConfig();
  if (!config) return null;

  const resp = await fetch(
    `${config.url}/rest/v1/calendar_events?id=eq.${eventId}&user_id=eq.${userId}`,
    {
      method: 'PATCH',
      headers: headers(config.key, { Prefer: 'return=representation' }),
      body: JSON.stringify({ ...updates, updated_at: new Date().toISOString() }),
    },
  );

  if (!resp.ok) {
    console.error(`${LOG_PREFIX} updateCalendarEvent failed:`, await resp.text());
    return null;
  }

  const rows = await resp.json() as CalendarEvent[];
  return rows[0] ?? null;
}

export async function rescheduleEvent(
  eventId: string,
  userId: string,
  newStartTime: string,
  newEndTime: string,
): Promise<CalendarEvent | null> {
  const config = getSupabaseConfig();
  if (!config) return null;

  // First fetch the current event to preserve original_start_time
  const fetchResp = await fetch(
    `${config.url}/rest/v1/calendar_events?id=eq.${eventId}&user_id=eq.${userId}&select=start_time,original_start_time,reschedule_count&limit=1`,
    { headers: headers(config.key) },
  );
  if (!fetchResp.ok) return null;
  const rows = await fetchResp.json() as any[];
  const current = rows[0];
  if (!current) return null;

  return updateCalendarEvent(eventId, userId, {
    start_time: newStartTime,
    end_time: newEndTime,
    original_start_time: current.original_start_time || current.start_time,
    reschedule_count: (current.reschedule_count || 0) + 1,
  });
}

// =============================================================================
// VTID-04374 — who may move an entry
// =============================================================================

/**
 * Why a member may NOT move this entry themselves, or null when they may.
 *
 * Only entries the member (or Vitana on their behalf) put there move: a
 * booked appointment, a lab order, a live room, an invite or a plan step is
 * owned by its source, and moving the calendar copy would be wrong (the
 * other party still expects the old time) and short-lived (the next source
 * update moves it back). A recurring series moves as a whole from where it
 * was made, never from one occurrence here.
 */
export type MoveBlockReason = 'cancelled' | 'completed' | 'recurring' | 'owned_by_source';

export function moveBlockReason(
  e: Pick<CalendarEvent, 'status' | 'completed_at' | 'rrule' | 'source_type' | 'source_ref_type'>,
): MoveBlockReason | null {
  if (e.status === 'cancelled') return 'cancelled';
  if (e.completed_at) return 'completed';
  if (e.rrule) return 'recurring';
  const src = e.source_type ?? 'manual';
  if (src === 'manual' || src === 'assistant') return null;
  if (src === 'autopilot' && (e.source_ref_type ?? 'autopilot_recommendation') === 'autopilot_recommendation') return null;
  if (src === 'journey' && e.source_ref_type === 'journey_task') return null;
  return 'owned_by_source';
}

export async function getOwnCalendarEvent(eventId: string, userId: string): Promise<CalendarEvent | null> {
  const config = getSupabaseConfig();
  if (!config) return null;
  const resp = await fetch(
    `${config.url}/rest/v1/calendar_events?id=eq.${encodeURIComponent(eventId)}&user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`,
    { headers: headers(config.key) },
  );
  if (!resp.ok) return null;
  const rows = (await resp.json()) as CalendarEvent[];
  return rows[0] ?? null;
}

export async function markEventActivated(
  eventId: string,
  userId: string,
): Promise<CalendarEvent | null> {
  return updateCalendarEvent(eventId, userId, {
    activated_at: new Date().toISOString(),
  });
}

export async function markEventCompleted(
  eventId: string,
  userId: string,
  completionStatus: string = 'completed',
  completionNotes?: string | null,
): Promise<CalendarEvent | null> {
  return updateCalendarEvent(eventId, userId, {
    completed_at: new Date().toISOString(),
    completion_status: completionStatus,
    completion_notes: completionNotes ?? null,
    activated_at: new Date().toISOString(), // also mark activated if not already
  });
}

export async function softDeleteEvent(
  eventId: string,
  userId: string,
): Promise<CalendarEvent | null> {
  return updateCalendarEvent(eventId, userId, { status: 'cancelled' });
}

// =============================================================================
// List with pagination
// =============================================================================

export async function listCalendarEvents(
  userId: string,
  role: string | null,
  opts: {
    from?: string;
    to?: string;
    event_type?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ data: CalendarEvent[]; count: number }> {
  const config = getSupabaseConfig();
  if (!config) return { data: [], count: 0 };

  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  let url = `${config.url}/rest/v1/calendar_events?user_id=eq.${userId}&order=start_time.desc&limit=${limit}&offset=${offset}`;

  const rf = roleFilter(role);
  if (rf) url += `&${rf}`;
  if (opts.from) url += `&start_time=gte.${opts.from}`;
  if (opts.to) url += `&start_time=lte.${opts.to}`;
  if (opts.event_type) url += `&event_type=eq.${opts.event_type}`;
  if (opts.status) url += `&status=eq.${opts.status}`;

  const resp = await fetch(url, {
    headers: headers(config.key, { Prefer: 'count=exact' }),
  });

  if (!resp.ok) {
    console.error(`${LOG_PREFIX} listCalendarEvents failed:`, await resp.text());
    return { data: [], count: 0 };
  }

  const countHeader = resp.headers.get('content-range');
  const count = countHeader ? parseInt(countHeader.split('/')[1] || '0', 10) : 0;
  const data = await resp.json() as CalendarEvent[];

  return { data, count };
}

// =============================================================================
// Conversion helpers
// =============================================================================

export function toSummary(event: CalendarEvent): CalendarEventSummary {
  return {
    id: event.id,
    title: event.title,
    start_time: event.start_time,
    end_time: event.end_time,
    event_type: event.event_type,
    status: event.status,
    role_context: event.role_context,
    completion_status: event.completion_status,
    priority_score: event.priority_score,
    wellness_tags: event.wellness_tags,
    pillar: event.pillar ?? null,
    contribution_vector: event.contribution_vector ?? null,
  };
}

// =============================================================================
// Phase 8: Calendar Pattern Extraction
// =============================================================================

export interface CalendarPattern {
  description: string;
  confidence: number;
  domain: string;
  pattern_type: 'habit' | 'pattern' | 'signal';
}

/**
 * Analyze calendar history to extract behavioral patterns.
 * These patterns feed into garden nodes and the assistant context.
 */
export async function extractCalendarPatterns(
  userId: string,
  role: string | null = 'community',
  daysBack: number = 30,
): Promise<CalendarPattern[]> {
  const history = await getUserCalendarHistory(userId, role, daysBack, 500);
  if (history.length < 5) return []; // Not enough data

  const patterns: CalendarPattern[] = [];
  const completed = history.filter(e => e.completion_status === 'completed');
  const skipped = history.filter(e => e.completion_status === 'skipped');

  // 1. Time-of-day preference
  const completionHours = completed.map(e => new Date(e.start_time).getHours());
  if (completionHours.length >= 5) {
    const morningCount = completionHours.filter(h => h >= 6 && h < 12).length;
    const afternoonCount = completionHours.filter(h => h >= 12 && h < 18).length;
    const eveningCount = completionHours.filter(h => h >= 18 && h < 23).length;
    const total = completionHours.length;

    if (morningCount / total > 0.6) {
      patterns.push({ description: 'User prefers completing tasks in the morning', confidence: Math.round((morningCount / total) * 100), domain: 'lifestyle', pattern_type: 'pattern' });
    } else if (afternoonCount / total > 0.6) {
      patterns.push({ description: 'User prefers completing tasks in the afternoon', confidence: Math.round((afternoonCount / total) * 100), domain: 'lifestyle', pattern_type: 'pattern' });
    } else if (eveningCount / total > 0.6) {
      patterns.push({ description: 'User prefers completing tasks in the evening', confidence: Math.round((eveningCount / total) * 100), domain: 'lifestyle', pattern_type: 'pattern' });
    }
  }

  // 2. Category completion rates
  const byType: Record<string, { completed: number; total: number }> = {};
  for (const e of history) {
    if (!byType[e.event_type]) byType[e.event_type] = { completed: 0, total: 0 };
    byType[e.event_type].total++;
    if (e.completion_status === 'completed') byType[e.event_type].completed++;
  }

  for (const [type, stats] of Object.entries(byType)) {
    if (stats.total >= 3) {
      const rate = stats.completed / stats.total;
      if (rate > 0.8) {
        patterns.push({ description: `User consistently completes ${type} events (${Math.round(rate * 100)}%)`, confidence: Math.round(rate * 100), domain: 'lifestyle', pattern_type: 'habit' });
      } else if (rate < 0.3) {
        patterns.push({ description: `User frequently skips ${type} events (${Math.round((1 - rate) * 100)}% skip rate)`, confidence: Math.round((1 - rate) * 100), domain: 'lifestyle', pattern_type: 'signal' });
      }
    }
  }

  // 3. Duration preference
  const completedDurations = completed
    .filter(e => e.end_time)
    .map(e => (new Date(e.end_time!).getTime() - new Date(e.start_time).getTime()) / 60000);
  if (completedDurations.length >= 5) {
    const shortCount = completedDurations.filter(d => d <= 15).length;
    const longCount = completedDurations.filter(d => d > 30).length;
    if (shortCount / completedDurations.length > 0.7) {
      patterns.push({ description: 'User prefers short tasks (15 min or less)', confidence: Math.round((shortCount / completedDurations.length) * 100), domain: 'lifestyle', pattern_type: 'pattern' });
    } else if (longCount / completedDurations.length > 0.5) {
      patterns.push({ description: 'User handles longer tasks well (30+ min)', confidence: Math.round((longCount / completedDurations.length) * 100), domain: 'lifestyle', pattern_type: 'pattern' });
    }
  }

  // 4. Wellness tag affinity
  const tagCounts: Record<string, { completed: number; total: number }> = {};
  for (const e of history) {
    for (const tag of e.wellness_tags || []) {
      if (!tagCounts[tag]) tagCounts[tag] = { completed: 0, total: 0 };
      tagCounts[tag].total++;
      if (e.completion_status === 'completed') tagCounts[tag].completed++;
    }
  }

  for (const [tag, stats] of Object.entries(tagCounts)) {
    if (stats.total >= 3) {
      const rate = stats.completed / stats.total;
      if (rate > 0.8) {
        patterns.push({ description: `User engages well with "${tag}" activities`, confidence: Math.round(rate * 100), domain: 'health', pattern_type: 'habit' });
      }
    }
  }

  return patterns;
}

// =============================================================================
// VTID-04331 — window read: recurrence expanded, other lenses as busy blocks
// =============================================================================

/**
 * One item the calendar UI renders for a date range. Recurring entries become
 * one item per occurrence (`occurrence_index` set, `id` = `${event_id}::${start}`).
 * Entries from a lens the active role does not see come back as grey busy
 * blocks: time only — no title, description, location, attendees or source.
 */
export interface CalendarWindowItem {
  id: string;
  event_id: string;
  start_time: string;
  end_time: string | null;
  busy: boolean;
  occurrence_index: number | null;
  event: CalendarEvent | null; // null for busy blocks
}

/** Drop everything identifying from an entry the active lens may not see. */
export function toBusyBlock(item: Omit<CalendarWindowItem, 'busy' | 'event'>): CalendarWindowItem {
  return { ...item, busy: true, event: null };
}

/**
 * Pure part of listCalendarWindow: expand + classify already-fetched rows.
 * Exported for tests.
 */
export function buildCalendarWindow(
  rows: CalendarEvent[],
  role: string | null,
  window: { from: string; to: string },
  opts: { includeBusy: boolean; fallbackTz: string; expand: (e: CalendarEvent) => Array<{ start: string; end: string; index: number }> },
): CalendarWindowItem[] {
  const visible = getVisibleContexts(role); // null = everything (super_admin)
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const items: CalendarWindowItem[] = [];

  for (const ev of rows) {
    if (ev.status === 'cancelled') continue;
    const canSee = visible === null || visible.includes(ev.role_context as any);
    if (!canSee && !opts.includeBusy) continue;

    const occurrences = ev.rrule
      ? opts.expand(ev).map((o) => ({ start: o.start, end: o.end, index: o.index as number | null }))
      : [{ start: ev.start_time, end: ev.end_time ?? ev.start_time, index: null as number | null }];

    for (const o of occurrences) {
      const s = Date.parse(o.start);
      const e = Math.max(Date.parse(o.end), s + 1);
      if (!(s < to && e > from)) continue;
      const base = {
        id: o.index === null ? ev.id : `${ev.id}::${o.start}`,
        event_id: ev.id,
        start_time: o.start,
        end_time: ev.rrule || ev.end_time ? o.end : null,
        occurrence_index: o.index,
      };
      items.push(canSee ? { ...base, busy: false, event: ev } : toBusyBlock(base));
    }
  }

  return items.sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
}

/**
 * Everything the calendar shows between `from` and `to` for the active role.
 * One-off entries are selected by overlap; recurring ones by having started
 * before `to` (their occurrences are then expanded and filtered).
 */
export async function listCalendarWindow(
  userId: string,
  role: string | null,
  window: { from: string; to: string },
  opts: { includeBusy?: boolean; userTimezone?: string } = {},
): Promise<CalendarWindowItem[]> {
  const config = getSupabaseConfig();
  if (!config) return [];
  const { expandOccurrences } = await import('./calendar-recurrence');
  const fallbackTz = opts.userTimezone || 'Europe/Berlin';
  const includeBusy = opts.includeBusy ?? true;

  // The lens filter is applied in buildCalendarWindow (busy blocks need the
  // other lenses' rows), so rows are fetched for the whole user here.
  const base = `${config.url}/rest/v1/calendar_events?user_id=eq.${encodeURIComponent(userId)}&status=neq.cancelled`;
  const oneOff =
    `${base}&rrule=is.null&start_time=lt.${encodeURIComponent(window.to)}` +
    `&or=(end_time.gt.${encodeURIComponent(window.from)},and(end_time.is.null,start_time.gte.${encodeURIComponent(window.from)}))` +
    `&order=start_time.asc&limit=1000`;
  const recurring = `${base}&rrule=not.is.null&start_time=lt.${encodeURIComponent(window.to)}&limit=500`;

  const [a, b] = await Promise.all([
    fetch(oneOff, { headers: headers(config.key) }),
    fetch(recurring, { headers: headers(config.key) }),
  ]);
  if (!a.ok || !b.ok) {
    console.error(`${LOG_PREFIX} listCalendarWindow failed:`, a.ok ? '' : await a.text(), b.ok ? '' : await b.text());
    return [];
  }
  const rows = [...((await a.json()) as CalendarEvent[]), ...((await b.json()) as CalendarEvent[])];

  return buildCalendarWindow(rows, role, window, {
    includeBusy,
    fallbackTz,
    expand: (ev) => expandOccurrences(
      { start_time: ev.start_time, end_time: ev.end_time, rrule: ev.rrule as string, timezone: ev.timezone },
      window,
      fallbackTz,
    ),
  });
}
