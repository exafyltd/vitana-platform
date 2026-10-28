/**
 * VTID-04358 — calendar step 7a: a private iCalendar (RFC 5545) subscription
 * feed, so Apple Calendar, Google Calendar or Outlook can subscribe to a
 * user's Vitanaland calendar.
 *
 * - One secret token per user. Only its SHA-256 hash is stored
 *   (calendar_feed_tokens), so the table alone never yields a working URL.
 *   Creating a new link replaces the old one; revoking deletes it.
 * - The feed carries the user's OWN entries (every lens they own), with
 *   recurring series expanded into occurrences. Work-lens items (VTID-04357)
 *   are not calendar rows and never appear.
 * - Only title, time and place leave the platform. Descriptions (which can
 *   hold health details) stay out, and so do alarms: Vitanaland already sends
 *   its own reminders, and an external alarm would double every one.
 */

import crypto from 'crypto';
import { getSupabaseConfig, headers, listCalendarWindow } from './calendar-service';

const LOG_PREFIX = '[CalendarIcsFeed]';
const DAY = 86_400_000;

/** Past and future span of the feed, relative to the request. */
export const FEED_PAST_DAYS = 30;
export const FEED_FUTURE_DAYS = 180;
/** An entry with no end time gets this length in the feed. */
const DEFAULT_MINUTES = 30;

export function newFeedToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashFeedToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A token has exactly the shape newFeedToken() produces. */
export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

// -----------------------------------------------------------------------------
// RFC 5545 formatting (pure)
// -----------------------------------------------------------------------------

/** UTC form, `YYYYMMDDTHHMMSSZ`. */
export function icsUtc(iso: string | number | Date): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** TEXT escaping (RFC 5545 §3.3.11). */
export function icsEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Folds a content line to 75 octets, never splitting a UTF-8 character. */
export function icsFold(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

export interface FeedEntry {
  uid: string;
  title: string;
  start: string;
  end: string | null;
  location: string | null;
  status: string | null;
  updated: string | null;
}

export function buildIcs(entries: FeedEntry[], now: Date = new Date()): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vitanaland//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Vitanaland',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  const stamp = icsUtc(now);
  for (const e of entries) {
    const startMs = Date.parse(e.start);
    if (Number.isNaN(startMs)) continue;
    const endMs = e.end && !Number.isNaN(Date.parse(e.end)) && Date.parse(e.end) > startMs
      ? Date.parse(e.end)
      : startMs + DEFAULT_MINUTES * 60_000;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${e.uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (e.updated && !Number.isNaN(Date.parse(e.updated))) lines.push(`LAST-MODIFIED:${icsUtc(e.updated)}`);
    lines.push(`DTSTART:${icsUtc(startMs)}`);
    lines.push(`DTEND:${icsUtc(endMs)}`);
    lines.push(`SUMMARY:${icsEscape(e.title)}`);
    if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
    lines.push(`STATUS:${e.status === 'pending' ? 'TENTATIVE' : 'CONFIRMED'}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

// -----------------------------------------------------------------------------
// Token store (service role only)
// -----------------------------------------------------------------------------

async function rest(path: string, init: RequestInit = {}, extra?: Record<string, string>): Promise<Response | null> {
  const config = getSupabaseConfig();
  if (!config) return null;
  return fetch(`${config.url}/rest/v1/${path}`, { ...init, headers: headers(config.key, extra) });
}

export async function getFeedStatus(userId: string): Promise<{ active: boolean; created_at: string | null; last_used_at: string | null }> {
  const res = await rest(`calendar_feed_tokens?user_id=eq.${encodeURIComponent(userId)}&select=created_at,last_used_at`);
  if (!res || !res.ok) throw new Error(`feed status read failed: ${res ? res.status : 'no config'}`);
  const rows = (await res.json()) as Array<{ created_at: string; last_used_at: string | null }>;
  return rows[0] ? { active: true, created_at: rows[0].created_at, last_used_at: rows[0].last_used_at } : { active: false, created_at: null, last_used_at: null };
}

/** Creates a new token for the user, replacing any existing one. Returns the plain token once. */
export async function rotateFeedToken(userId: string): Promise<string> {
  const token = newFeedToken();
  const res = await rest(
    'calendar_feed_tokens?on_conflict=user_id',
    {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, token_hash: hashFeedToken(token), created_at: new Date().toISOString(), last_used_at: null }),
    },
    { Prefer: 'resolution=merge-duplicates,return=minimal' },
  );
  if (!res || !res.ok) throw new Error(`feed token write failed: ${res ? `${res.status} ${await res.text()}` : 'no config'}`);
  return token;
}

export async function revokeFeedToken(userId: string): Promise<void> {
  const res = await rest(`calendar_feed_tokens?user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE' });
  if (!res || !res.ok) throw new Error(`feed token delete failed: ${res ? res.status : 'no config'}`);
}

/** The user a token belongs to, or null. Malformed tokens never reach the database. */
export async function resolveFeedToken(token: string): Promise<string | null> {
  if (!isWellFormedToken(token)) return null;
  const res = await rest(`calendar_feed_tokens?token_hash=eq.${hashFeedToken(token)}&select=user_id`);
  if (!res || !res.ok) {
    console.error(`${LOG_PREFIX} token lookup failed: ${res ? res.status : 'no config'}`);
    return null;
  }
  const rows = (await res.json()) as Array<{ user_id: string }>;
  return rows[0]?.user_id ?? null;
}

function touch(userId: string): void {
  void rest(
    `calendar_feed_tokens?user_id=eq.${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: JSON.stringify({ last_used_at: new Date().toISOString() }) },
    { Prefer: 'return=minimal' },
  ).catch(() => undefined);
}

/** The whole feed body for a user. */
export async function buildFeedForUser(userId: string, now: Date = new Date()): Promise<string> {
  const window = {
    from: new Date(now.getTime() - FEED_PAST_DAYS * DAY).toISOString(),
    to: new Date(now.getTime() + FEED_FUTURE_DAYS * DAY).toISOString(),
  };
  // super_admin = no lens filter: these are all the user's own rows.
  const items = await listCalendarWindow(userId, 'super_admin', window, { includeBusy: false });
  const entries: FeedEntry[] = items
    .filter((it) => it.event && !it.busy)
    .map((it) => ({
      uid: `${it.occurrence_index === null ? it.event_id : `${it.event_id}-${icsUtc(it.start_time)}`}@vitanaland`,
      title: it.event!.title,
      start: it.start_time,
      end: it.end_time,
      location: it.event!.location,
      status: it.event!.status,
      updated: it.event!.updated_at,
    }));
  touch(userId);
  return buildIcs(entries, now);
}
