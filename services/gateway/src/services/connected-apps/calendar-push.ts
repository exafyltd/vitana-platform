/**
 * VTID-04436: push Vitanaland calendar entries into the member's Outlook and
 * iPhone (iCloud) calendars — the same thing the Google sync does
 * (VTID-04372), for the two other calendar apps on the Connected Apps screen.
 *
 * Each provider gets one calendar named "Vitanaland" in the member's own
 * account, created by the push. Only that calendar is ever written; the
 * member's other calendars are only read, for busy times. A member's own
 * community / personal entries go there (PUSHED_ROLE_CONTEXTS), with no
 * reminders of their own — Vitanaland already reminds (VTID-04338), so the
 * phone would buzz twice.
 *
 *   Outlook  Microsoft Graph, scope Calendars.ReadWrite (already requested
 *            by the outlook-calendar toggle). Repeat rules become Graph
 *            patternedRecurrence.
 *   iCloud   CalDAV: MKCALENDAR once, then PUT / DELETE one .ics per entry.
 *            Repeat rules are written as RRULE unchanged.
 *
 * A link row per pushed entry holds the remote id and a hash of what was
 * sent, so a sync only writes what changed. The pull side (busy times)
 * skips the Vitanaland calendar, or every pushed entry would come back as a
 * grey block on top of itself.
 *
 * Kill switch: CONNECTED_APPS_CALENDAR_PUSH=false leaves both apps pull-only.
 */

import { createHash } from 'crypto';
import { isPushable, PUSH_LOOKBACK_MS, MAX_WRITES_PER_USER, type SyncEntry } from '../calendar-google-sync';
import { localParts, parseRRule } from '../calendar-recurrence';
import { db, enc } from './db';

export type PushProvider = 'microsoft' | 'apple';

export const PUSH_CALENDAR_NAME = 'Vitanaland';
const MINUTE = 60_000;

export function calendarPushEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONNECTED_APPS_CALENDAR_PUSH !== 'false';
}

// ---------------------------------------------------------------------------
// Pure: plan
// ---------------------------------------------------------------------------

export interface PushLink {
  id: string;
  calendar_event_id: string | null;
  remote_id: string;
  pushed_hash: string;
}

export type ExternalPushOp<B> =
  | { op: 'create'; entryId: string; body: B; hash: string }
  | { op: 'update'; entryId: string; linkId: string; remoteId: string; body: B; hash: string }
  | { op: 'delete'; linkId: string; remoteId: string };

export function hashOf(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/**
 * What to write for a member's entries and existing links. Pure. `render`
 * returns null for an entry the provider cannot represent (it is then treated
 * like an entry that is not pushed). Entries outside the read window are
 * absent, and their links are left alone.
 */
export function planExternalPush<B>(
  entries: SyncEntry[],
  links: PushLink[],
  render: (e: SyncEntry) => { body: B; hash: string } | null,
): ExternalPushOp<B>[] {
  const linkByEntry = new Map(links.filter((l) => l.calendar_event_id).map((l) => [l.calendar_event_id as string, l]));
  const ops: ExternalPushOp<B>[] = [];
  for (const l of links) if (!l.calendar_event_id) ops.push({ op: 'delete', linkId: l.id, remoteId: l.remote_id });
  for (const e of entries) {
    const link = linkByEntry.get(e.id);
    const rendered = isPushable(e) ? render(e) : null;
    if (!rendered) {
      if (link) ops.push({ op: 'delete', linkId: link.id, remoteId: link.remote_id });
      continue;
    }
    if (!link) ops.push({ op: 'create', entryId: e.id, ...rendered });
    else if (link.pushed_hash !== rendered.hash) {
      ops.push({ op: 'update', entryId: e.id, linkId: link.id, remoteId: link.remote_id, ...rendered });
    }
  }
  return ops;
}

function span(e: SyncEntry): { start: number; end: number } {
  const start = Date.parse(e.start_time);
  const endRaw = e.end_time ? Date.parse(e.end_time) : NaN;
  return { start, end: Number.isNaN(endRaw) || endRaw <= start ? start + 30 * MINUTE : endRaw };
}

function title(e: SyncEntry): string {
  return `${e.emoji ? `${e.emoji} ` : ''}${e.title}`.trim();
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Wall-clock date/time of an instant in a zone, e.g. 2026-09-23T07:30:00. */
export function localIso(epochMs: number, tz: string): string {
  const l = localParts(epochMs, tz);
  return `${l.y}-${pad(l.mo)}-${pad(l.d)}T${pad(l.h)}:${pad(l.mi)}:${pad(l.s)}`;
}

// ---------------------------------------------------------------------------
// Pure: Outlook (Graph event)
// ---------------------------------------------------------------------------

const GRAPH_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export interface GraphRecurrence {
  pattern: {
    type: 'daily' | 'weekly' | 'absoluteMonthly';
    interval: number;
    daysOfWeek?: string[];
    dayOfMonth?: number;
    firstDayOfWeek?: 'monday';
  };
  range: {
    type: 'noEnd' | 'endDate' | 'numbered';
    startDate: string;
    endDate?: string;
    numberOfOccurrences?: number;
    recurrenceTimeZone: string;
  };
}

/**
 * The repeat rules the app writes (FREQ=DAILY|WEEKLY|MONTHLY with INTERVAL,
 * COUNT, UNTIL, weekly BYDAY — the valid_rrule CHECK) as a Graph recurrence,
 * anchored on the entry's local start. Null for a rule it cannot parse.
 */
export function toGraphRecurrence(rrule: string, startMs: number, tz: string): GraphRecurrence | null {
  const r = parseRRule(rrule.replace(/^RRULE:/, ''));
  if (!r) return null;
  const startLocal = localIso(startMs, tz);
  const startDate = startLocal.slice(0, 10);
  const weekday = new Date(`${startDate}T12:00:00Z`).getUTCDay();
  const pattern: GraphRecurrence['pattern'] =
    r.freq === 'DAILY'
      ? { type: 'daily', interval: r.interval }
      : r.freq === 'WEEKLY'
        ? { type: 'weekly', interval: r.interval, daysOfWeek: (r.byday ?? [weekday]).map((d) => GRAPH_DAYS[d]), firstDayOfWeek: 'monday' }
        : { type: 'absoluteMonthly', interval: r.interval, dayOfMonth: Number(startDate.slice(8, 10)) };
  const range: GraphRecurrence['range'] =
    r.count !== null
      ? { type: 'numbered', startDate, numberOfOccurrences: r.count, recurrenceTimeZone: tz }
      : r.until !== null
        ? { type: 'endDate', startDate, endDate: localIso(r.until, tz).slice(0, 10), recurrenceTimeZone: tz }
        : { type: 'noEnd', startDate, recurrenceTimeZone: tz };
  return { pattern, range };
}

export interface GraphEventBody {
  subject: string;
  body?: { contentType: 'text'; content: string };
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isReminderOn: false;
  showAs: 'busy';
  recurrence?: GraphRecurrence;
}

/**
 * One entry as a Graph event. A single entry is written in UTC; a repeating
 * one in its own zone, so a 07:30 habit stays at 07:30 across a DST change.
 * Null when its repeat rule cannot be expressed.
 */
export function toGraphEvent(e: SyncEntry, fallbackTz: string): GraphEventBody | null {
  const tz = e.timezone || fallbackTz;
  const { start, end } = span(e);
  if (Number.isNaN(start)) return null;
  const zone = e.rrule ? tz : 'UTC';
  const body: GraphEventBody = {
    subject: title(e),
    start: { dateTime: localIso(start, zone), timeZone: zone },
    end: { dateTime: localIso(end, zone), timeZone: zone },
    isReminderOn: false,
    showAs: 'busy',
  };
  if (e.description) body.body = { contentType: 'text', content: e.description };
  if (e.rrule) {
    const rec = toGraphRecurrence(e.rrule, start, tz);
    if (!rec) return null;
    body.recurrence = rec;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Pure: iCloud (iCalendar)
// ---------------------------------------------------------------------------

/** RFC 5545 TEXT escaping. */
export function icsEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold content lines longer than 75 octets (RFC 5545 §3.1), never splitting a UTF-8 character. */
export function icsFold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + b > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const icsUtc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsLocal = (ms: number, tz: string) => localIso(ms, tz).replace(/[-:]/g, '');

/** The iCloud resource name for an entry — stable, so an update overwrites it. */
export function icsUid(entryId: string): string {
  return `vitanaland-${entryId}`;
}

/**
 * One entry as an iCalendar object. DTSTAMP is a parameter so the hash can
 * be taken over a fixed stamp. Repeating entries carry the zone as TZID
 * (without a VTIMEZONE block; iCloud resolving the Olson name is not yet
 * verified against a live account) so they keep their wall-clock time.
 */
export function toIcs(e: SyncEntry, fallbackTz: string, dtstamp: string): string | null {
  const tz = e.timezone || fallbackTz;
  const { start, end } = span(e);
  if (Number.isNaN(start)) return null;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vitanaland//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${icsUid(e.id)}@vitanaland.com`,
    `DTSTAMP:${dtstamp}`,
  ];
  if (e.rrule) {
    if (!parseRRule(e.rrule.replace(/^RRULE:/, ''))) return null;
    lines.push(`DTSTART;TZID=${tz}:${icsLocal(start, tz)}`, `DTEND;TZID=${tz}:${icsLocal(end, tz)}`);
    lines.push(`RRULE:${e.rrule.replace(/^RRULE:/, '')}`);
  } else {
    lines.push(`DTSTART:${icsUtc(start)}`, `DTEND:${icsUtc(end)}`);
  }
  lines.push(`SUMMARY:${icsEscape(title(e))}`);
  if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
  lines.push('TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(icsFold).join('\r\n')}\r\n`;
}

const FIXED_STAMP = '19700101T000000Z';

export function renderIcs(e: SyncEntry, fallbackTz: string, now: number): { body: string; hash: string } | null {
  const fixed = toIcs(e, fallbackTz, FIXED_STAMP);
  if (!fixed) return null;
  return { body: fixed.replace(`DTSTAMP:${FIXED_STAMP}`, `DTSTAMP:${icsUtc(now)}`), hash: hashOf(fixed) };
}

export function renderGraph(e: SyncEntry, fallbackTz: string): { body: GraphEventBody; hash: string } | null {
  const body = toGraphEvent(e, fallbackTz);
  return body ? { body, hash: hashOf(body) } : null;
}

// ---------------------------------------------------------------------------
// I/O: state
// ---------------------------------------------------------------------------

export async function loadTarget(userId: string, provider: PushProvider): Promise<string | null> {
  const rows = (await db(
    `calendar_push_targets?select=remote_calendar_id&user_id=eq.${enc(userId)}&provider=eq.${provider}&limit=1`,
  )) as Array<{ remote_calendar_id: string | null }>;
  return rows?.[0]?.remote_calendar_id ?? null;
}

async function saveTarget(userId: string, provider: PushProvider, remoteCalendarId: string | null): Promise<void> {
  await db('calendar_push_targets?on_conflict=user_id,provider', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, provider, remote_calendar_id: remoteCalendarId, updated_at: new Date().toISOString() }),
  });
}

async function dropLinks(userId: string, provider: PushProvider): Promise<void> {
  await db(`calendar_push_links?user_id=eq.${enc(userId)}&provider=eq.${provider}`, { method: 'DELETE' });
}

export async function loadLinks(userId: string, provider: PushProvider): Promise<PushLink[]> {
  return ((await db(
    `calendar_push_links?select=id,calendar_event_id,remote_id,pushed_hash&user_id=eq.${enc(userId)}&provider=eq.${provider}`,
  )) ?? []) as PushLink[];
}

/**
 * Switching the app off forgets the push state. The Vitanaland calendar
 * stays in the member's account — theirs to keep or delete, as with Google.
 */
export async function forgetPush(userId: string, provider: PushProvider): Promise<void> {
  await dropLinks(userId, provider).catch(() => undefined);
  await db(`calendar_push_targets?user_id=eq.${enc(userId)}&provider=eq.${provider}`, { method: 'DELETE' }).catch(() => undefined);
}

async function loadEntries(userId: string, now: number): Promise<SyncEntry[]> {
  const cols = 'id,title,description,start_time,end_time,rrule,timezone,status,role_context,emoji';
  const since = enc(new Date(now - PUSH_LOOKBACK_MS).toISOString());
  return ((await db(
    `calendar_events?select=${cols}&user_id=eq.${enc(userId)}&or=(rrule.not.is.null,start_time.gte.${since})&order=start_time.asc&limit=1000`,
  )) ?? []) as SyncEntry[];
}

async function memberTimezone(userId: string): Promise<string> {
  const { createClient } = await import('@supabase/supabase-js');
  const { getUserTimezone } = await import('../daily-pace-service');
  const { resolveUserTimezone } = await import('../guide/user-timezone');
  const client = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE as string);
  return resolveUserTimezone(await getUserTimezone(client as any, userId));
}

async function linkCreated(userId: string, provider: PushProvider, entryId: string, remoteId: string, hash: string, now: number): Promise<void> {
  await db('calendar_push_links?on_conflict=provider,calendar_event_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, provider, calendar_event_id: entryId, remote_id: remoteId, pushed_hash: hash, pushed_at: new Date(now).toISOString() }),
  });
}

async function linkUpdated(linkId: string, hash: string, now: number): Promise<void> {
  await db(`calendar_push_links?id=eq.${enc(linkId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ pushed_hash: hash, pushed_at: new Date(now).toISOString() }),
  });
}

async function linkDeleted(linkId: string): Promise<void> {
  await db(`calendar_push_links?id=eq.${enc(linkId)}`, { method: 'DELETE' });
}

export interface PushResult {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  /** Remote ids now in the Vitanaland calendar (for the pull to skip). */
  pushed_ids: Set<string>;
  /** The Vitanaland calendar (Graph id or CalDAV collection URL). */
  calendar: string;
}

/** Thrown when the member deleted the Vitanaland calendar; the next sync recreates it. */
export class PushCalendarGone extends Error {
  constructor() {
    super('vitanaland_calendar_missing');
  }
}

// ---------------------------------------------------------------------------
// I/O: Outlook
// ---------------------------------------------------------------------------

async function ensureOutlookCalendar(token: string, userId: string): Promise<string> {
  const known = await loadTarget(userId, 'microsoft');
  if (known) return known;
  const { graph } = await import('../../connectors/productivity/microsoft');
  const made = await graph(token, 'POST', '/me/calendars', { name: PUSH_CALENDAR_NAME });
  let id: string | undefined = made.ok ? made.json?.id : undefined;
  if (!id) {
    // A calendar with that name already exists (an earlier connection): reuse it.
    const found = await graph(token, 'GET', `/me/calendars?$select=id,name&$filter=${enc(`name eq '${PUSH_CALENDAR_NAME}'`)}`);
    id = found.ok ? found.json?.value?.[0]?.id : undefined;
    if (!id) throw new Error(made.status === 403 ? 'permission_not_granted' : `outlook_calendar_create_failed_${made.status}`);
  }
  await saveTarget(userId, 'microsoft', id);
  // A new calendar holds none of the old links' events.
  await dropLinks(userId, 'microsoft');
  return id;
}

export async function pushOutlook(userId: string, token: string, now: number = Date.now()): Promise<PushResult> {
  const { graph } = await import('../../connectors/productivity/microsoft');
  const tz = await memberTimezone(userId);
  const calendarId = await ensureOutlookCalendar(token, userId);
  const [entries, links] = await Promise.all([loadEntries(userId, now), loadLinks(userId, 'microsoft')]);
  const all = planExternalPush(entries, links, (e) => renderGraph(e, tz));
  const ops = all.slice(0, MAX_WRITES_PER_USER);
  const res: PushResult = { created: 0, updated: 0, deleted: 0, skipped: 0, pushed_ids: new Set(), calendar: calendarId };
  res.skipped = entries.filter((e) => isPushable(e) && !renderGraph(e, tz)).length;

  for (const op of ops) {
    if (op.op === 'create') {
      const r = await graph(token, 'POST', `/me/calendars/${enc(calendarId)}/events`, op.body);
      if (r.status === 404) {
        await saveTarget(userId, 'microsoft', null);
        throw new PushCalendarGone();
      }
      if (!r.ok || !r.json?.id) throw new Error(`outlook_push_${r.status}: ${r.errorMessage ?? ''}`.trim());
      await linkCreated(userId, 'microsoft', op.entryId, r.json.id, op.hash, now);
      res.created++;
    } else if (op.op === 'update') {
      const r = await graph(token, 'PATCH', `/me/events/${enc(op.remoteId)}`, op.body);
      if (r.status === 404) {
        // Deleted in Outlook: create it again on the next sync.
        await linkDeleted(op.linkId);
        continue;
      }
      if (!r.ok) throw new Error(`outlook_push_${r.status}: ${r.errorMessage ?? ''}`.trim());
      await linkUpdated(op.linkId, op.hash, now);
      res.updated++;
    } else {
      const r = await graph(token, 'DELETE', `/me/events/${enc(op.remoteId)}`);
      if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`outlook_push_${r.status}: ${r.errorMessage ?? ''}`.trim());
      await linkDeleted(op.linkId);
      res.deleted++;
    }
  }
  for (const l of await loadLinks(userId, 'microsoft')) res.pushed_ids.add(l.remote_id);
  return res;
}

// ---------------------------------------------------------------------------
// I/O: iCloud
// ---------------------------------------------------------------------------

function mkcalendarBody(): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>' +
    `<d:displayname>${PUSH_CALENDAR_NAME}</d:displayname>` +
    '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>' +
    '</d:prop></d:set></c:mkcalendar>'
  );
}

async function ensureAppleCalendar(
  creds: import('./apple-dav').AppleCredentials,
  home: string,
  userId: string,
): Promise<string> {
  const known = await loadTarget(userId, 'apple');
  if (known) return known;
  const dav = await import('./apple-dav');
  const url = new URL('vitanaland/', home.endsWith('/') ? home : `${home}/`).toString();
  try {
    await dav.davWrite(creds, 'MKCALENDAR', url, mkcalendarBody(), { 'Content-Type': 'application/xml; charset=utf-8' });
  } catch (err) {
    // 405: the collection already exists (an earlier connection) — reuse it.
    if (!(err instanceof dav.DavStatusError && err.status === 405)) throw err;
  }
  await saveTarget(userId, 'apple', url);
  await dropLinks(userId, 'apple');
  return url;
}

export async function pushApple(
  userId: string,
  creds: import('./apple-dav').AppleCredentials,
  caldavHome: string,
  now: number = Date.now(),
): Promise<PushResult> {
  const dav = await import('./apple-dav');
  const tz = await memberTimezone(userId);
  const calendarUrl = await ensureAppleCalendar(creds, caldavHome, userId);
  const [entries, links] = await Promise.all([loadEntries(userId, now), loadLinks(userId, 'apple')]);
  const ops = planExternalPush(entries, links, (e) => renderIcs(e, tz, now)).slice(0, MAX_WRITES_PER_USER);
  const res: PushResult = { created: 0, updated: 0, deleted: 0, skipped: 0, pushed_ids: new Set(), calendar: calendarUrl };
  res.skipped = entries.filter((e) => isPushable(e) && !renderIcs(e, tz, now)).length;
  const ics = { 'Content-Type': 'text/calendar; charset=utf-8' };

  for (const op of ops) {
    try {
      if (op.op === 'create') {
        const resource = new URL(`${icsUid(op.entryId)}.ics`, calendarUrl).toString();
        await dav.davWrite(creds, 'PUT', resource, op.body, ics);
        await linkCreated(userId, 'apple', op.entryId, resource, op.hash, now);
        res.created++;
      } else if (op.op === 'update') {
        await dav.davWrite(creds, 'PUT', op.remoteId, op.body, ics);
        await linkUpdated(op.linkId, op.hash, now);
        res.updated++;
      } else {
        try {
          await dav.davWrite(creds, 'DELETE', op.remoteId);
        } catch (err) {
          if (!(err instanceof dav.DavStatusError && (err.status === 404 || err.status === 410))) throw err;
        }
        await linkDeleted(op.linkId);
        res.deleted++;
      }
    } catch (err) {
      // PUT into a collection that no longer exists: the member deleted it.
      if (err instanceof dav.DavStatusError && (err.status === 404 || err.status === 409) && op.op !== 'delete') {
        await saveTarget(userId, 'apple', null);
        throw new PushCalendarGone();
      }
      throw err;
    }
  }
  return res;
}
