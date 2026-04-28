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
): Promise<CalendarEvent | null> {
  const config = getSupabaseConfig();
  if (!config) return null;

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
