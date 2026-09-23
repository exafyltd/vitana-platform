/**
 * VTID-04331 — the one way a system writes into a user's calendar.
 *
 * Every producer (Autopilot, the assistant, goal plans, health plans, lab
 * orders, appointments, community sign-ups, …) owns the calendar entries it
 * created, identified by (user_id, source_ref_type, source_ref_id) — the key
 * of the existing unique index idx_calendar_events_source_ref. Through this
 * module a producer can:
 *
 *   upsertCalendarEntryFromSource   create or update ONE entry (idempotent;
 *                                   re-running is a no-op or an update)
 *   upsertCalendarSeriesFromSource  replace a whole set of entries for one
 *                                   source (a plan): new keys are created,
 *                                   changed ones updated, keys no longer in
 *                                   the set cancelled — so replacing a plan
 *                                   never leaves orphaned entries behind
 *   cancelCalendarEntriesForSource  withdraw (a plan is cancelled, an order
 *                                   refunded, an RSVP withdrawn)
 *   completeCalendarEntriesForSource the source was completed elsewhere, tick
 *                                   its entries off too
 *
 * and completeSourceForCalendarEvent closes the loop the other way: ticking
 * the entry off in the calendar completes its source.
 *
 * Rules every write follows:
 *   - a completed entry keeps its completion: a later upsert never moves or
 *     un-completes it;
 *   - a cancelled entry that the producer sends again is reactivated;
 *   - the unique index is the source of truth; a concurrent insert that
 *     loses the race (23505) is resolved by re-reading and updating.
 *
 * PostgREST's on_conflict cannot target a PARTIAL unique index, hence the
 * read-then-write instead of a single upsert.
 */

import { CalendarEvent, CreateCalendarEventInput, CALENDAR_SOURCE_TYPES } from '../types/calendar';
import { getSupabaseConfig, headers } from './calendar-service';

const LOG_PREFIX = '[CalendarProducers]';

export type CalendarSourceType = (typeof CALENDAR_SOURCE_TYPES)[number];

export interface CalendarSourceRef {
  source_type: CalendarSourceType;
  /** What kind of thing owns the entry, e.g. 'autopilot_recommendation', 'goal_plan_step'. */
  source_ref_type: string;
  /** The owning thing's id. */
  source_ref_id: string;
}

/** Fields a producer may set. Identity/source fields come from the ref. */
export type CalendarEntryFields = Omit<
  Partial<CreateCalendarEventInput>,
  'source_type' | 'source_ref_type' | 'source_ref_id'
> & { title: string; start_time: string };

export type UpsertAction = 'created' | 'updated' | 'reactivated' | 'unchanged' | 'kept_completed' | 'failed';

export interface UpsertResult {
  action: UpsertAction;
  event: CalendarEvent | null;
  error?: string;
}

/** Fields compared to decide whether an existing entry needs an update. */
const COMPARED_FIELDS = [
  'title', 'description', 'start_time', 'end_time', 'location', 'event_type',
  'role_context', 'priority', 'priority_score', 'pillar', 'rrule', 'timezone',
  'reminder_offsets', 'emoji', 'wellness_tags', 'metadata', 'contribution_vector',
] as const;

/** Postgres returns timestamps as "+00:00"; producers send "Z". Compare instants. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined) return true; // producer did not send the field
  if (typeof a === 'string' && typeof b === 'string') {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (/^\d{4}-\d{2}-\d{2}T/.test(a) && !Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb;
    return a === b;
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The subset of `fields` that differs from `existing`. Exported for tests. */
export function diffEntry(existing: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of COMPARED_FIELDS) {
    if (!(key in fields)) continue;
    if (!sameValue(fields[key], existing[key])) changed[key] = fields[key];
  }
  return changed;
}

function refFilter(userId: string, ref: Pick<CalendarSourceRef, 'source_ref_type' | 'source_ref_id'>): string {
  return (
    `user_id=eq.${encodeURIComponent(userId)}` +
    `&source_ref_type=eq.${encodeURIComponent(ref.source_ref_type)}` +
    `&source_ref_id=eq.${encodeURIComponent(ref.source_ref_id)}`
  );
}

async function fetchByRef(
  cfg: { url: string; key: string },
  userId: string,
  ref: CalendarSourceRef,
): Promise<CalendarEvent | null> {
  const resp = await fetch(`${cfg.url}/rest/v1/calendar_events?${refFilter(userId, ref)}&limit=1`, {
    headers: headers(cfg.key),
  });
  if (!resp.ok) throw new Error(`read failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const rows = (await resp.json()) as CalendarEvent[];
  return rows[0] ?? null;
}

async function patchById(
  cfg: { url: string; key: string },
  id: string,
  patch: Record<string, unknown>,
): Promise<CalendarEvent | null> {
  const resp = await fetch(`${cfg.url}/rest/v1/calendar_events?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: headers(cfg.key, { Prefer: 'return=representation' }),
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!resp.ok) throw new Error(`update failed ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const rows = (await resp.json()) as CalendarEvent[];
  return rows[0] ?? null;
}

function applyToExisting(
  cfg: { url: string; key: string },
  existing: CalendarEvent,
  fields: Record<string, unknown>,
): Promise<UpsertResult> {
  return (async () => {
    if (existing.completed_at || existing.completion_status === 'completed') {
      return { action: 'kept_completed' as const, event: existing };
    }
    const changed = diffEntry(existing as unknown as Record<string, unknown>, fields);
    const reactivate = existing.status === 'cancelled';
    if (!reactivate && Object.keys(changed).length === 0) {
      return { action: 'unchanged' as const, event: existing };
    }
    const patch: Record<string, unknown> = { ...changed };
    if (reactivate) patch.status = (fields.status as string | undefined) ?? 'confirmed';
    const event = await patchById(cfg, existing.id, patch);
    return { action: reactivate ? ('reactivated' as const) : ('updated' as const), event };
  })();
}

export async function upsertCalendarEntryFromSource(
  userId: string,
  ref: CalendarSourceRef,
  entry: CalendarEntryFields,
): Promise<UpsertResult> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { action: 'failed', event: null, error: 'supabase_config_missing' };
  if (!userId || !ref.source_ref_id || !ref.source_ref_type) {
    return { action: 'failed', event: null, error: 'user_id, source_ref_type and source_ref_id are required' };
  }

  const fields: Record<string, unknown> = { ...entry };
  try {
    const existing = await fetchByRef(cfg, userId, ref);
    if (existing) return await applyToExisting(cfg, existing, fields);

    const resp = await fetch(`${cfg.url}/rest/v1/calendar_events`, {
      method: 'POST',
      headers: headers(cfg.key, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        user_id: userId,
        status: 'confirmed',
        ...fields,
        source_type: ref.source_type,
        source_ref_type: ref.source_ref_type,
        source_ref_id: ref.source_ref_id,
      }),
    });
    if (resp.ok) {
      const rows = (await resp.json()) as CalendarEvent[];
      return { action: 'created', event: rows[0] ?? null };
    }
    const errText = await resp.text();
    if (resp.status === 409 || errText.includes('23505')) {
      // Lost a race with a concurrent write for the same source: treat as an update.
      const winner = await fetchByRef(cfg, userId, ref);
      if (winner) return await applyToExisting(cfg, winner, fields);
    }
    throw new Error(`insert failed ${resp.status}: ${errText.slice(0, 200)}`);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} upsert ${ref.source_ref_type}/${ref.source_ref_id} failed:`, err?.message);
    return { action: 'failed', event: null, error: err?.message ?? 'unknown' };
  }
}

export interface SeriesEntry extends CalendarEntryFields {
  /** Stable key of this entry within the series, e.g. a plan step id or "day-3". */
  key: string;
}

export interface SeriesResult {
  created: number;
  updated: number;
  unchanged: number;
  cancelled: number;
  failed: number;
  events: CalendarEvent[];
}

/** source_ref_id of one series entry. Exported so producers can find an entry again. */
export function seriesEntryRefId(seriesId: string, key: string): string {
  return `${seriesId}:${key}`;
}

/**
 * Make the user's calendar hold exactly `entries` for this series. Keys no
 * longer present are cancelled (completed ones are left alone — they happened).
 */
export async function upsertCalendarSeriesFromSource(
  userId: string,
  series: { source_type: CalendarSourceType; source_ref_type: string; series_id: string },
  entries: SeriesEntry[],
): Promise<SeriesResult> {
  const result: SeriesResult = { created: 0, updated: 0, unchanged: 0, cancelled: 0, failed: 0, events: [] };
  const keep = new Set<string>();

  for (const { key, ...fields } of entries) {
    const refId = seriesEntryRefId(series.series_id, key);
    keep.add(refId);
    const r = await upsertCalendarEntryFromSource(
      userId,
      { source_type: series.source_type, source_ref_type: series.source_ref_type, source_ref_id: refId },
      fields,
    );
    if (r.action === 'created') result.created++;
    else if (r.action === 'updated' || r.action === 'reactivated') result.updated++;
    else if (r.action === 'failed') result.failed++;
    else result.unchanged++;
    if (r.event) result.events.push(r.event);
  }

  result.cancelled = await cancelCalendarEntriesForSource(userId, series.source_ref_type, {
    prefix: series.series_id,
    exceptRefIds: keep,
  });
  return result;
}

/**
 * Cancel the live, not-yet-completed entries a source owns. `target` is one
 * source_ref_id, or a series prefix (every `${prefix}:*` entry, optionally
 * minus `exceptRefIds`). Returns how many entries were cancelled.
 */
export async function cancelCalendarEntriesForSource(
  userId: string,
  sourceRefType: string,
  target: string | { prefix: string; exceptRefIds?: Set<string> },
): Promise<number> {
  const cfg = getSupabaseConfig();
  if (!cfg) return 0;

  let filter =
    `user_id=eq.${encodeURIComponent(userId)}` +
    `&source_ref_type=eq.${encodeURIComponent(sourceRefType)}` +
    `&status=neq.cancelled&completed_at=is.null`;
  if (typeof target === 'string') {
    filter += `&source_ref_id=eq.${encodeURIComponent(target)}`;
  } else {
    filter += `&source_ref_id=like.${encodeURIComponent(`${target.prefix}:*`)}`;
    const except = [...(target.exceptRefIds ?? [])];
    if (except.length) {
      const list = except.map((id) => `"${id.replace(/"/g, '')}"`).join(',');
      filter += `&source_ref_id=not.in.(${encodeURIComponent(list)})`;
    }
  }

  try {
    const resp = await fetch(`${cfg.url}/rest/v1/calendar_events?${filter}`, {
      method: 'PATCH',
      headers: headers(cfg.key, { Prefer: 'return=representation' }),
      body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() }),
    });
    if (!resp.ok) {
      console.error(`${LOG_PREFIX} cancel ${sourceRefType} failed (${resp.status}):`, (await resp.text()).slice(0, 200));
      return 0;
    }
    return ((await resp.json()) as unknown[]).length;
  } catch (err: any) {
    console.error(`${LOG_PREFIX} cancel ${sourceRefType} failed:`, err?.message);
    return 0;
  }
}

/** The source was completed somewhere else: tick its open entries off too. */
export async function completeCalendarEntriesForSource(
  userId: string,
  sourceRefType: string,
  sourceRefId: string,
  completionStatus: 'completed' | 'skipped' | 'partial' = 'completed',
): Promise<number> {
  const cfg = getSupabaseConfig();
  if (!cfg) return 0;
  const now = new Date().toISOString();
  const filter = `${refFilter(userId, { source_ref_type: sourceRefType, source_ref_id: sourceRefId })}&status=neq.cancelled&completed_at=is.null`;
  try {
    const resp = await fetch(`${cfg.url}/rest/v1/calendar_events?${filter}`, {
      method: 'PATCH',
      headers: headers(cfg.key, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        completed_at: now,
        completion_status: completionStatus,
        activated_at: now,
        updated_at: now,
      }),
    });
    if (!resp.ok) {
      console.error(`${LOG_PREFIX} complete ${sourceRefType} failed (${resp.status}):`, (await resp.text()).slice(0, 200));
      return 0;
    }
    return ((await resp.json()) as unknown[]).length;
  } catch (err: any) {
    console.error(`${LOG_PREFIX} complete ${sourceRefType} failed:`, err?.message);
    return 0;
  }
}

/**
 * The entry was ticked off in the calendar: complete the thing it came from.
 * Today that is an Autopilot recommendation (through the same RPC the
 * recommendation route uses, so its reward and state transition stay in one
 * transaction). Other source types get their handler when step 5 connects
 * them. Best-effort: returns whether a source was completed.
 */
export async function completeSourceForCalendarEvent(
  event: Pick<CalendarEvent, 'source_ref_type' | 'source_ref_id'>,
  userId: string,
): Promise<{ completed: boolean; source_ref_type: string | null; error?: string }> {
  const type = event.source_ref_type ?? null;
  if (!type || !event.source_ref_id) return { completed: false, source_ref_type: type };
  if (type !== 'autopilot_recommendation') return { completed: false, source_ref_type: type };

  const cfg = getSupabaseConfig();
  if (!cfg) return { completed: false, source_ref_type: type, error: 'supabase_config_missing' };
  try {
    const resp = await fetch(`${cfg.url}/rest/v1/rpc/complete_autopilot_recommendation`, {
      method: 'POST',
      headers: headers(cfg.key),
      body: JSON.stringify({ p_recommendation_id: event.source_ref_id, p_user_id: userId }),
    });
    if (!resp.ok) {
      const err = (await resp.text()).slice(0, 200);
      console.warn(`${LOG_PREFIX} completing recommendation ${event.source_ref_id} failed (${resp.status}): ${err}`);
      return { completed: false, source_ref_type: type, error: err };
    }
    const body = (await resp.json()) as { ok?: boolean; error?: string } | null;
    return { completed: body?.ok === true, source_ref_type: type, error: body?.ok ? undefined : body?.error };
  } catch (err: any) {
    return { completed: false, source_ref_type: type, error: err?.message };
  }
}
