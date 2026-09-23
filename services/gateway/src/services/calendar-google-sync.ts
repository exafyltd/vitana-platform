/**
 * VTID-04372 — calendar step 7b: Google Calendar two-way sync. Built, switched off.
 *
 * Push: a member's own community / personal entries go to a "Vitanaland"
 * calendar the app creates in their Google account. The narrow scope
 * `calendar.app.created` means the sync can only ever touch that calendar,
 * never the member's other ones. Pushed events carry no Google reminders —
 * Vitanaland already reminds (VTID-04338), so the phone would buzz twice.
 *
 * Pull: only free/busy intervals of the member's Google primary calendar
 * (`calendar.freebusy`). No titles, no attendees. They show up in the window
 * read as grey busy blocks, the same as another role's entries.
 *
 * Tokens: the existing Google connection in social_connections, loaded and
 * refreshed through the connector dispatcher. No second OAuth flow.
 *
 * Off unless CALENDAR_GOOGLE_SYNC_ENABLED is exactly 'true' AND the Google
 * OAuth client is configured. Anything else reports `not_configured`.
 */

import { createHash } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';

const LOG_PREFIX = '[CalendarGoogleSync]';
const GCAL = 'https://www.googleapis.com/calendar/v3';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Past entries pushed on the first sync; older history stays out of Google. */
export const PUSH_LOOKBACK_MS = 7 * DAY;
/** How far ahead busy times are pulled. */
export const PULL_HORIZON_MS = 30 * DAY;
/** Per member per tick, so one large calendar cannot starve the rest. */
export const MAX_WRITES_PER_USER = 100;
export const MAX_USERS_PER_TICK = 50;
/** Only a member's own life goes to Google, never the admin/dev lenses. */
export const PUSHED_ROLE_CONTEXTS = ['community', 'personal'] as const;

export const GOOGLE_SYNC_CONNECT_URL = '/api/v1/social-accounts/connect/google?include=calendar_sync&mode=incremental';

export type GoogleSyncAvailability = 'ready' | 'not_configured';

export function googleSyncAvailability(env: NodeJS.ProcessEnv = process.env): GoogleSyncAvailability {
  if (env.CALENDAR_GOOGLE_SYNC_ENABLED !== 'true') return 'not_configured';
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) return 'not_configured';
  return 'ready';
}

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

export interface SyncEntry {
  id: string;
  title: string;
  description?: string | null;
  start_time: string;
  end_time: string | null;
  rrule?: string | null;
  timezone?: string | null;
  status: string;
  role_context?: string | null;
  emoji?: string | null;
}

export interface GoogleEventBody {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  recurrence?: string[];
  reminders: { useDefault: false; overrides: [] };
  extendedProperties: { private: { vitanaland_event_id: string } };
}

export function isPushable(e: Pick<SyncEntry, 'status' | 'role_context'>): boolean {
  return e.status !== 'cancelled' && (PUSHED_ROLE_CONTEXTS as readonly string[]).includes(e.role_context ?? 'community');
}

/** The Google event a calendar entry becomes. Pure. */
export function toGoogleEvent(e: SyncEntry, fallbackTz: string): GoogleEventBody {
  const tz = e.timezone || fallbackTz;
  const startMs = Date.parse(e.start_time);
  const endMs = e.end_time ? Date.parse(e.end_time) : NaN;
  const end = Number.isNaN(endMs) || endMs <= startMs ? startMs + 30 * MINUTE : endMs;
  const body: GoogleEventBody = {
    summary: `${e.emoji ? `${e.emoji} ` : ''}${e.title}`.trim(),
    start: { dateTime: new Date(startMs).toISOString(), timeZone: tz },
    end: { dateTime: new Date(end).toISOString(), timeZone: tz },
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { vitanaland_event_id: e.id } },
  };
  if (e.description) body.description = e.description;
  if (e.rrule) body.recurrence = [e.rrule.startsWith('RRULE:') ? e.rrule : `RRULE:${e.rrule}`];
  return body;
}

export function pushHash(body: GoogleEventBody): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export interface LinkRow {
  id: string;
  calendar_event_id: string | null;
  google_event_id: string;
  pushed_hash: string;
}

export type PushOp =
  | { op: 'create'; entryId: string; body: GoogleEventBody; hash: string }
  | { op: 'update'; entryId: string; linkId: string; googleId: string; body: GoogleEventBody; hash: string }
  | { op: 'delete'; linkId: string; googleId: string };

/**
 * What to do in Google for a member's entries and existing links. Pure.
 * Entries outside the read window are simply absent: their links are left
 * alone, so old history in Google is never deleted by the lookback moving on.
 */
export function planPush(entries: SyncEntry[], links: LinkRow[], fallbackTz: string): PushOp[] {
  const linkByEntry = new Map(links.filter((l) => l.calendar_event_id).map((l) => [l.calendar_event_id as string, l]));
  const ops: PushOp[] = [];
  for (const l of links) if (!l.calendar_event_id) ops.push({ op: 'delete', linkId: l.id, googleId: l.google_event_id });
  for (const e of entries) {
    const link = linkByEntry.get(e.id);
    if (!isPushable(e)) {
      if (link) ops.push({ op: 'delete', linkId: link.id, googleId: link.google_event_id });
      continue;
    }
    const body = toGoogleEvent(e, fallbackTz);
    const hash = pushHash(body);
    if (!link) ops.push({ op: 'create', entryId: e.id, body, hash });
    else if (link.pushed_hash !== hash) ops.push({ op: 'update', entryId: e.id, linkId: link.id, googleId: link.google_event_id, body, hash });
  }
  return ops;
}

/** Google freeBusy response → clean, merged intervals. Pure. */
export function normalizeBusy(busy: Array<{ start?: string; end?: string }>): Array<{ start_time: string; end_time: string }> {
  const iv = busy
    .map((b) => ({ s: Date.parse(b.start ?? ''), e: Date.parse(b.end ?? '') }))
    .filter((b) => !Number.isNaN(b.s) && !Number.isNaN(b.e) && b.e > b.s)
    .sort((a, b) => a.s - b.s);
  const out: Array<{ s: number; e: number }> = [];
  for (const b of iv) {
    const last = out[out.length - 1];
    if (last && b.s <= last.e) last.e = Math.max(last.e, b.e);
    else out.push({ ...b });
  }
  return out.map((b) => ({ start_time: new Date(b.s).toISOString(), end_time: new Date(b.e).toISOString() }));
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function cfg(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  return url && key ? { url, key } : null;
}

function h(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

async function db(path: string, init: RequestInit = {}): Promise<any> {
  const c = cfg();
  if (!c) throw new Error('supabase_config_missing');
  const r = await fetch(`${c.url}/rest/v1/${path}`, { ...init, headers: h(c.key, (init.headers as Record<string, string>) ?? {}) });
  if (!r.ok) throw new Error(`db ${init.method ?? 'GET'} ${path.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

class GoogleApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function gcal(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${GCAL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = ((await r.json()) as any)?.error?.message ?? msg; } catch { /* non-JSON */ }
    throw new GoogleApiError(r.status, `google ${method} ${path.split('?')[0]} ${r.status}: ${msg}`);
  }
  return r.status === 204 ? null : r.json();
}

async function accessToken(userId: string): Promise<string | null> {
  const c = cfg();
  if (!c) return null;
  const { createClient } = await import('@supabase/supabase-js');
  const { getConnectorAccessToken } = await import('../connectors/runtime/dispatcher');
  return getConnectorAccessToken(createClient(c.url, c.key) as any, userId, 'google', ['google']);
}

export interface SyncState {
  user_id: string;
  enabled: boolean;
  google_calendar_id: string | null;
  last_push_at: string | null;
  last_pull_at: string | null;
  last_error: string | null;
}

export async function getSyncState(userId: string): Promise<SyncState | null> {
  const rows = (await db(`calendar_google_sync?select=*&user_id=eq.${encodeURIComponent(userId)}`)) as SyncState[];
  return rows[0] ?? null;
}

async function patchState(userId: string, patch: Partial<SyncState>): Promise<void> {
  await db(`calendar_google_sync?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

export type EnableResult =
  | { ok: true; state: SyncState }
  | { ok: false; error: 'not_configured' }
  | { ok: false; error: 'not_connected'; connect_url: string };

/** Turn sync on for a member. Needs a Google connection with the sync scopes. */
export async function enableGoogleSync(userId: string): Promise<EnableResult> {
  if (googleSyncAvailability() !== 'ready') return { ok: false, error: 'not_configured' };
  if (!(await accessToken(userId))) return { ok: false, error: 'not_connected', connect_url: GOOGLE_SYNC_CONNECT_URL };
  const rows = (await db('calendar_google_sync?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ user_id: userId, enabled: true, last_error: null, updated_at: new Date().toISOString() }),
  })) as SyncState[];
  return { ok: true, state: rows[0] };
}

/**
 * Turn sync off. The Vitanaland calendar stays in the member's Google
 * account (it is theirs to keep or delete); pulled busy times are removed.
 */
export async function disableGoogleSync(userId: string): Promise<void> {
  const u = encodeURIComponent(userId);
  await db(`calendar_google_sync?user_id=eq.${u}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }),
  });
  await db(`calendar_external_busy?user_id=eq.${u}&source=eq.google`, { method: 'DELETE' });
}

export interface UserSyncResult {
  user_id: string;
  ok: boolean;
  created: number;
  updated: number;
  deleted: number;
  busy: number;
  error?: string;
}

async function ensureCalendar(token: string, state: SyncState, tz: string): Promise<string> {
  if (state.google_calendar_id) return state.google_calendar_id;
  const cal = await gcal(token, 'POST', '/calendars', { summary: 'Vitanaland', timeZone: tz });
  await patchState(state.user_id, { google_calendar_id: cal.id });
  // A new calendar holds none of the old links' events.
  await db(`calendar_google_links?user_id=eq.${encodeURIComponent(state.user_id)}`, { method: 'DELETE' });
  return cal.id as string;
}

/** Push then pull for one member. Never throws; the error lands on the state row. */
export async function syncUser(state: SyncState, now: number = Date.now()): Promise<UserSyncResult> {
  const result: UserSyncResult = { user_id: state.user_id, ok: false, created: 0, updated: 0, deleted: 0, busy: 0 };
  const u = encodeURIComponent(state.user_id);
  try {
    const token = await accessToken(state.user_id);
    if (!token) throw new Error('not_connected');
    const { createClient } = await import('@supabase/supabase-js');
    const { getUserTimezone } = await import('./daily-pace-service');
    const { resolveUserTimezone } = await import('./guide/user-timezone');
    const c = cfg()!;
    const tz = resolveUserTimezone(await getUserTimezone(createClient(c.url, c.key) as any, state.user_id));

    let calendarId = await ensureCalendar(token, state, tz);

    // ---- push ----
    const cols = 'id,title,description,start_time,end_time,rrule,timezone,status,role_context,emoji';
    const since = encodeURIComponent(new Date(now - PUSH_LOOKBACK_MS).toISOString());
    const [entries, links] = await Promise.all([
      db(`calendar_events?select=${cols}&user_id=eq.${u}&or=(rrule.not.is.null,start_time.gte.${since})&order=start_time.asc&limit=1000`) as Promise<SyncEntry[]>,
      db(`calendar_google_links?select=id,calendar_event_id,google_event_id,pushed_hash&user_id=eq.${u}`) as Promise<LinkRow[]>,
    ]);
    const ops = planPush(entries, links, tz).slice(0, MAX_WRITES_PER_USER);
    const path = () => `/calendars/${encodeURIComponent(calendarId)}/events`;
    for (const op of ops) {
      try {
        if (op.op === 'create') {
          const ev = await gcal(token, 'POST', path(), op.body);
          await db('calendar_google_links?on_conflict=calendar_event_id', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ user_id: state.user_id, calendar_event_id: op.entryId, google_event_id: ev.id, pushed_hash: op.hash, pushed_at: new Date(now).toISOString() }),
          });
          result.created++;
        } else if (op.op === 'update') {
          await gcal(token, 'PUT', `${path()}/${encodeURIComponent(op.googleId)}`, op.body);
          await db(`calendar_google_links?id=eq.${op.linkId}`, {
            method: 'PATCH',
            body: JSON.stringify({ pushed_hash: op.hash, pushed_at: new Date(now).toISOString() }),
          });
          result.updated++;
        } else {
          try {
            await gcal(token, 'DELETE', `${path()}/${encodeURIComponent(op.googleId)}`);
          } catch (err) {
            // Already gone in Google (the member deleted it) — just forget the link.
            if (!(err instanceof GoogleApiError && (err.status === 404 || err.status === 410))) throw err;
          }
          await db(`calendar_google_links?id=eq.${op.linkId}`, { method: 'DELETE' });
          result.deleted++;
        }
      } catch (err) {
        // The member deleted the Vitanaland calendar: recreate it next run.
        if (err instanceof GoogleApiError && err.status === 404 && op.op !== 'delete') {
          await patchState(state.user_id, { google_calendar_id: null });
          calendarId = '';
          throw new Error('vitanaland_calendar_missing');
        }
        throw err;
      }
    }

    // ---- pull ----
    const fb = await gcal(token, 'POST', '/freeBusy', {
      timeMin: new Date(now).toISOString(),
      timeMax: new Date(now + PULL_HORIZON_MS).toISOString(),
      items: [{ id: 'primary' }],
    });
    const busy = normalizeBusy(fb?.calendars?.primary?.busy ?? []);
    await db(`calendar_external_busy?user_id=eq.${u}&source=eq.google`, { method: 'DELETE' });
    if (busy.length) {
      await db('calendar_external_busy', {
        method: 'POST',
        body: JSON.stringify(busy.map((b) => ({ ...b, user_id: state.user_id, source: 'google', fetched_at: new Date(now).toISOString() }))),
      });
    }
    result.busy = busy.length;

    const at = new Date(now).toISOString();
    await patchState(state.user_id, { last_push_at: at, last_pull_at: at, last_error: null });
    return { ...result, ok: true };
  } catch (err: any) {
    const message = String(err?.message ?? err).slice(0, 500);
    result.error = message;
    console.warn(`${LOG_PREFIX} user ${state.user_id.slice(0, 8)} failed: ${message}`);
    try {
      await patchState(state.user_id, { last_error: message });
    } catch { /* state write failed too; logged above */ }
    // Only a new failure is a state transition worth recording.
    if (state.last_error !== message) {
      emitOasisEvent({
        vtid: 'VTID-04372',
        type: 'calendar.google_sync.failed' as any,
        source: 'calendar-google-sync',
        status: 'warning',
        message: `Google Calendar sync failed: ${message.slice(0, 120)}`,
        payload: { user_id: state.user_id, error: message },
      }).catch(() => {});
    }
    return result;
  }
}

export interface TickResult {
  ok: boolean;
  skipped?: 'not_configured';
  users: number;
  failed: number;
}

export async function runGoogleSyncTick(now: number = Date.now()): Promise<TickResult> {
  if (googleSyncAvailability() !== 'ready') return { ok: true, skipped: 'not_configured', users: 0, failed: 0 };
  const states = (await db(
    `calendar_google_sync?select=*&enabled=is.true&order=last_push_at.asc.nullsfirst&limit=${MAX_USERS_PER_TICK}`,
  )) as SyncState[];
  let failed = 0;
  for (const s of states) if (!(await syncUser(s, now)).ok) failed++;
  if (states.length) console.log(`${LOG_PREFIX} users=${states.length} failed=${failed}`);
  return { ok: true, users: states.length, failed };
}

/** Busy intervals from Google overlapping the window, as window busy items. */
export async function listExternalBusy(
  userId: string,
  window: { from: string; to: string },
): Promise<Array<{ id: string; event_id: string; start_time: string; end_time: string; busy: true; occurrence_index: null; event: null; source: 'google' }>> {
  if (!cfg()) return [];
  try {
    const rows = (await db(
      `calendar_external_busy?select=id,start_time,end_time&user_id=eq.${encodeURIComponent(userId)}` +
        `&start_time=lt.${encodeURIComponent(window.to)}&end_time=gt.${encodeURIComponent(window.from)}&order=start_time.asc&limit=500`,
    )) as Array<{ id: string; start_time: string; end_time: string }>;
    return rows.map((r) => ({
      id: `google:${r.id}`,
      event_id: `google:${r.id}`,
      start_time: r.start_time,
      end_time: r.end_time,
      busy: true as const,
      occurrence_index: null,
      event: null,
      source: 'google' as const,
    }));
  } catch (err: any) {
    // The window must still render without the Google layer.
    console.warn(`${LOG_PREFIX} busy read failed: ${err?.message}`);
    return [];
  }
}

const TICK_EVERY_MS = 10 * MINUTE;
let loopStarted = false;

/** Sync every 10 min; starts only when googleSyncAvailability() is 'ready'. */
export function startGoogleSyncLoop(): boolean {
  if (loopStarted || googleSyncAvailability() !== 'ready') return false;
  loopStarted = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runGoogleSyncTick();
    } catch (err: any) {
      console.error(`${LOG_PREFIX} tick failed:`, err?.message);
    } finally {
      running = false;
    }
  };
  setInterval(tick, TICK_EVERY_MS).unref?.();
  setTimeout(tick, 150_000).unref?.();
  return true;
}
