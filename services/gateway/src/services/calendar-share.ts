/**
 * VTID-04916 — share a calendar entry to the news feed.
 * VTID-05126 — any of the member's own upcoming entries can be shared.
 *
 * The post is an ordinary `profile_posts` row with an attached reference
 * (attached_ref_type / attached_ref_id, migrations in vitana-v1):
 *   - an entry that belongs to a community event or a live room session is
 *     shared AS that event (`community_event` / `live_room_session`): the
 *     feed renders a live event card and the one-share-per-event index
 *     applies;
 *   - every other own entry — business, private, medical, a reminder, an
 *     imported or Autopilot entry, whatever its source — is shared as
 *     `calendar_entry` (attached_ref_id = the entry id). Other members cannot
 *     read the author's calendar (owner-only RLS), so the post carries
 *     `attached_snapshot`: title (the member may rename it for the card),
 *     start/end time, emoji, status and — only when the member chose to
 *     show it — the location. Nothing else of the entry (description,
 *     notes, source, health tags, attendees, metadata) is ever copied. A
 *     database trigger keeps the snapshot's times and status current.
 *
 * Rules (plan VTID-05126, sparred, owner-approved 2026-10-12):
 *   - Own entry only (user_id from the verified JWT; the caller never names
 *     it), upcoming: not cancelled, not completed, not ended, not a series.
 *   - One share per member per event / entry (unique index); a second
 *     attempt answers 409 ALREADY_SHARED with the existing post id.
 *   - At most SHARE_LIMIT_PER_DAY shares per member per 24 h (429).
 *   - Notifications are the database's job (trg_notify_community_post),
 *     deduplicated per recipient per shared thing per 24 h.
 */
import { createHash } from 'crypto';
import { getSupabaseConfig, headers } from './calendar-service';

const LOG_PREFIX = '[CalendarShare]';

export type ShareRefType = 'community_event' | 'live_room_session' | 'calendar_entry';
export const SHARE_LIMIT_PER_DAY = 5;
export const SHARE_TEXT_MAX = 2000;
export const CARD_TITLE_MAX = 120;

/** Sources whose entries are health information: sharing them is the member's choice, made knowingly. */
export const SENSITIVE_SOURCES: ReadonlySet<string> = new Set(['health_plan', 'lab_order', 'appointment', 'test_result']);

export interface ShareRef {
  ref_type: ShareRefType;
  ref_id: string;
}

export interface EntryLike {
  id?: string;
  user_id?: string;
  title?: string | null;
  status?: string | null;
  source_type?: string | null;
  source_ref_type?: string | null;
  source_ref_id?: string | null;
  metadata?: Record<string, unknown> | null;
  end_time?: string | null;
  start_time?: string | null;
  location?: string | null;
  emoji?: string | null;
  rrule?: string | null;
  completed_at?: string | null;
  completion_status?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The shareable thing behind a calendar entry, or null. Trigger-written RSVP
 * rows carry source_ref (community_event); older client-written rows only
 * carry metadata.meetup_id. Live room rows carry source_ref live_room_session.
 */
export function shareRefOf(entry: EntryLike | null | undefined): ShareRef | null {
  if (!entry) return null;
  const refType = entry.source_ref_type ?? null;
  const refId = entry.source_ref_id ? String(entry.source_ref_id) : null;
  if ((refType === 'community_event' || refType === 'live_room_session') && refId && UUID_RE.test(refId)) {
    return { ref_type: refType, ref_id: refId };
  }
  const meetup = entry.metadata && typeof entry.metadata === 'object' ? (entry.metadata as Record<string, unknown>).meetup_id : null;
  if (typeof meetup === 'string' && UUID_RE.test(meetup)) return { ref_type: 'community_event', ref_id: meetup };
  return null;
}

/**
 * What a share or invite of this entry points at: its community event or
 * live room when it has one (always tried first, so an RSVP entry is shared
 * as the event and the one-share-per-event index keeps working), otherwise
 * the member's own entry itself.
 */
export function entryShareRefOf(entry: EntryLike | null | undefined): ShareRef | null {
  const eventRef = shareRefOf(entry);
  if (eventRef) return eventRef;
  const id = entry?.id ? String(entry.id) : '';
  return UUID_RE.test(id) ? { ref_type: 'calendar_entry', ref_id: id } : null;
}

export type NotOpenReason = 'cancelled' | 'done' | 'recurring' | 'past';

/** Why an own entry can no longer be shared or invited to, or null while it is upcoming. */
export function entryNotOpenReason(entry: EntryLike, now: Date = new Date()): NotOpenReason | null {
  if (entry.status === 'cancelled') return 'cancelled';
  if (entry.completed_at || entry.completion_status) return 'done';
  if (entry.rrule) return 'recurring';
  const start = Date.parse(entry.start_time || '');
  const end = Date.parse(entry.end_time || '') || start + 3_600_000;
  if (!Number.isFinite(end) || end <= now.getTime()) return 'past';
  return null;
}

/**
 * Cheap check for the calendar window: can this own entry be shared (and
 * invited to) right now? The full check (the event still exists and is
 * public) runs on submit.
 */
export function isShareableEntry(entry: EntryLike | null | undefined, now: Date = new Date()): boolean {
  if (!entry) return false;
  return entryNotOpenReason(entry, now) === null && entryShareRefOf(entry) !== null;
}

export function isSensitiveEntry(entry: EntryLike | null | undefined): boolean {
  return !!entry?.source_type && SENSITIVE_SOURCES.has(String(entry.source_type));
}

/** The member's choices for what others see of an own entry. */
export interface CardChoice {
  card_title?: string;
  include_location?: boolean;
}

/** Title and location others see for an own entry (the member may rename it; the place is shown only on request). */
export function entryCard(entry: EntryLike, choice: CardChoice = {}): { title: string; location: string | null } {
  const custom = (choice.card_title ?? '').trim().slice(0, CARD_TITLE_MAX);
  const title = custom || String(entry.title ?? '').trim().slice(0, CARD_TITLE_MAX);
  const location = choice.include_location === true ? (String(entry.location ?? '').trim() || null) : null;
  return { title, location };
}

/**
 * VTID-05126: binds the assistant's confirmed share/invite of an own entry to
 * the card the member approved in the preview. The preview returns this token;
 * a confirmed call whose card differs (a dropped card_title, an added place)
 * or that carries no token is refused, so nothing private goes out unseen.
 * Null for an entry shared as its community event / live room (no card choice).
 */
export function cardToken(entry: EntryLike, card: { title: string; location: string | null }): string | null {
  if (shareRefOf(entry)) return null;
  return createHash('sha256').update(JSON.stringify([String(entry.id ?? ''), card.title, card.location])).digest('hex').slice(0, 12);
}

/** True when a confirmed call may proceed: no card choice, or the token the preview gave matches. */
export function cardTokenMatches(entry: EntryLike, card: { title: string; location: string | null }, token: unknown): boolean {
  const expected = cardToken(entry, card);
  return expected === null || token === expected;
}

export interface EntrySnapshot {
  title: string;
  start_time: string;
  end_time: string | null;
  location: string | null;
  emoji: string | null;
  status: string;
}

/** The card a `calendar_entry` post carries: these fields and nothing else of the entry. */
export function entrySnapshot(entry: EntryLike, choice: CardChoice = {}): EntrySnapshot {
  const card = entryCard(entry, choice);
  return {
    title: card.title,
    start_time: String(entry.start_time),
    end_time: entry.end_time ?? null,
    location: card.location,
    emoji: entry.emoji ? String(entry.emoji).slice(0, 16) : null,
    status: 'confirmed',
  };
}

type TargetCheck =
  | { ok: true; title: string }
  | { ok: false; reason: 'not_found' | 'cancelled' | 'past' | 'not_public' };

async function getJson<T>(path: string): Promise<T | null> {
  const config = getSupabaseConfig();
  if (!config) return null;
  const resp = await fetch(`${config.url}/rest/v1/${path}`, { headers: headers(config.key) });
  if (!resp.ok) {
    console.error(`${LOG_PREFIX} GET ${path.split('?')[0]} failed: ${resp.status}`);
    return null;
  }
  return (await resp.json()) as T;
}

/** The real, current state of the event behind a share. */
export async function checkShareTarget(ref: ShareRef, now: Date = new Date()): Promise<TargetCheck> {
  // An own entry is checked against the member's own row by the caller, never here.
  if (ref.ref_type === 'calendar_entry') return { ok: false, reason: 'not_found' };
  if (ref.ref_type === 'community_event') {
    const rows = await getJson<Array<{ title: string | null; start_time: string | null; end_time: string | null }>>(
      `global_community_events?id=eq.${encodeURIComponent(ref.ref_id)}&select=title,start_time,end_time&limit=1`,
    );
    const ev = rows?.[0];
    if (!ev || !ev.start_time) return { ok: false, reason: 'not_found' };
    const end = Date.parse(ev.end_time || '') || Date.parse(ev.start_time) + 3_600_000;
    if (end <= now.getTime()) return { ok: false, reason: 'past' };
    return { ok: true, title: ev.title || '' };
  }
  const rows = await getJson<Array<{ status: string | null; starts_at: string | null; ends_at: string | null; session_title: string | null; room_id: string | null }>>(
    `live_room_sessions?id=eq.${encodeURIComponent(ref.ref_id)}&select=status,starts_at,ends_at,session_title,room_id&limit=1`,
  );
  const s = rows?.[0];
  if (!s || !s.starts_at) return { ok: false, reason: 'not_found' };
  if (s.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  const end = Date.parse(s.ends_at || '') || Date.parse(s.starts_at) + 3_600_000;
  if (s.status === 'ended' || end <= now.getTime()) return { ok: false, reason: 'past' };
  if (s.room_id) {
    const rooms = await getJson<Array<{ access_level: string | null; title: string | null }>>(
      `live_rooms?id=eq.${encodeURIComponent(s.room_id)}&select=access_level,title&limit=1`,
    );
    const room = rooms?.[0];
    if (room && room.access_level && room.access_level !== 'public') return { ok: false, reason: 'not_public' };
    return { ok: true, title: s.session_title || room?.title || '' };
  }
  return { ok: true, title: s.session_title || '' };
}

/** Post ids of the member's existing shares, by event id. */
export async function listSharedPostIds(userId: string, refIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(refIds.filter((id) => UUID_RE.test(id)))];
  if (!ids.length) return out;
  const rows = await getJson<Array<{ id: string; attached_ref_id: string }>>(
    `profile_posts?user_id=eq.${encodeURIComponent(userId)}&attached_ref_id=in.(${ids.join(',')})&select=id,attached_ref_id`,
  );
  for (const r of rows ?? []) out.set(String(r.attached_ref_id), String(r.id));
  return out;
}

export type ShareResult =
  | { ok: true; post_id: string; ref: ShareRef }
  | { ok: false; status: number; error: string; post_id?: string; reason?: string };

export interface ShareInput extends CardChoice {
  text?: string;
  is_public?: boolean;
}

/**
 * Shares one of the member's own calendar entries to the feed. `userId` must
 * be the verified identity; `entry` the member's own row (the caller loads it
 * with getOwnCalendarEvent so another member's entry id answers 404).
 */
export async function shareCalendarEntryToFeed(
  userId: string,
  entry: EntryLike | null,
  input: ShareInput,
  now: Date = new Date(),
): Promise<ShareResult> {
  if (!entry || entry.user_id !== userId) return { ok: false, status: 404, error: 'NOT_FOUND' };
  const notOpen = entryNotOpenReason(entry, now);
  if (notOpen) return { ok: false, status: 409, error: 'NOT_SHAREABLE', reason: notOpen };
  const ref = entryShareRefOf(entry);
  if (!ref) return { ok: false, status: 409, error: 'NOT_SHAREABLE', reason: 'not_found' };

  const config = getSupabaseConfig();
  if (!config) return { ok: false, status: 503, error: 'NOT_CONFIGURED' };

  const existing = await listSharedPostIds(userId, [ref.ref_id]);
  const already = existing.get(ref.ref_id);
  if (already) return { ok: false, status: 409, error: 'ALREADY_SHARED', post_id: already };

  if (ref.ref_type !== 'calendar_entry') {
    const target = await checkShareTarget(ref, now);
    if (!target.ok) return { ok: false, status: 409, error: 'NOT_SHAREABLE', reason: target.reason };
  }

  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const recent = await getJson<Array<{ id: string }>>(
    `profile_posts?user_id=eq.${encodeURIComponent(userId)}&attached_ref_id=not.is.null&created_at=gte.${encodeURIComponent(since)}&select=id&limit=${SHARE_LIMIT_PER_DAY}`,
  );
  if ((recent?.length ?? 0) >= SHARE_LIMIT_PER_DAY) return { ok: false, status: 429, error: 'SHARE_LIMIT' };

  const text = (input.text ?? '').trim().slice(0, SHARE_TEXT_MAX);
  const resp = await fetch(`${config.url}/rest/v1/profile_posts`, {
    method: 'POST',
    headers: headers(config.key, { Prefer: 'return=representation' }),
    body: JSON.stringify({
      user_id: userId,
      content: text,
      is_public: input.is_public !== false,
      attached_ref_type: ref.ref_type,
      attached_ref_id: ref.ref_id,
      ...(ref.ref_type === 'calendar_entry' ? { attached_snapshot: entrySnapshot(entry, input) } : {}),
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    // profile_posts_block_duplicate also answers 23505: the member posted the
    // same text moments ago. That is not an earlier share of this event.
    if (/duplicate_post_suppressed/.test(body)) return { ok: false, status: 409, error: 'DUPLICATE_POST' };
    // A second request racing the first lands on the unique index.
    if (resp.status === 409 || /23505|duplicate/i.test(body)) {
      const again = (await listSharedPostIds(userId, [ref.ref_id])).get(ref.ref_id);
      return { ok: false, status: 409, error: 'ALREADY_SHARED', ...(again ? { post_id: again } : {}) };
    }
    if (/RATE_LIMITED/.test(body)) return { ok: false, status: 429, error: 'RATE_LIMITED' };
    if (/USER_SUSPENDED/.test(body)) return { ok: false, status: 403, error: 'USER_SUSPENDED' };
    console.error(`${LOG_PREFIX} insert failed: ${resp.status} ${body.slice(0, 300)}`);
    return { ok: false, status: 500, error: 'INSERT_FAILED' };
  }
  const rows = (await resp.json()) as Array<{ id: string }>;
  const postId = rows?.[0]?.id;
  if (!postId) return { ok: false, status: 500, error: 'INSERT_FAILED' };
  return { ok: true, post_id: String(postId), ref };
}

// ---------------------------------------------------------------------------
// "In meinen Kalender" — a member adds a shared own entry to their calendar
// ---------------------------------------------------------------------------

export type AddFromPostResult =
  | { ok: true; action: 'added' | 'already'; event_id: string | null }
  | { ok: false; status: number; error: string };

interface SharedPostRow {
  id: string;
  user_id: string;
  is_public: boolean | null;
  attached_ref_type: string | null;
  attached_snapshot: Partial<EntrySnapshot> | null;
}

/**
 * Copies the card of a public `calendar_entry` post into the viewer's own
 * calendar (title, times, the place only if the author showed it). Reads the
 * post's CURRENT snapshot, so a cancelled or finished entry is never copied.
 * Idempotent: the copy is keyed by (viewer, 'feed_post', post id).
 */
export async function addSharedEntryToCalendar(viewerId: string, postId: string, now: Date = new Date()): Promise<AddFromPostResult> {
  if (!UUID_RE.test(postId)) return { ok: false, status: 404, error: 'NOT_FOUND' };
  const rows = await getJson<SharedPostRow[]>(
    `profile_posts?id=eq.${encodeURIComponent(postId)}&select=id,user_id,is_public,attached_ref_type,attached_snapshot&limit=1`,
  );
  const post = rows?.[0];
  if (!post || post.is_public !== true || post.attached_ref_type !== 'calendar_entry' || !post.attached_snapshot) {
    return { ok: false, status: 404, error: 'NOT_FOUND' };
  }
  if (post.user_id === viewerId) return { ok: false, status: 409, error: 'OWN_POST' };
  const snap = post.attached_snapshot;
  const start = Date.parse(String(snap.start_time ?? ''));
  const end = Date.parse(String(snap.end_time ?? '')) || start + 3_600_000;
  if (snap.status === 'cancelled' || !Number.isFinite(end) || end <= now.getTime()) {
    return { ok: false, status: 409, error: 'NOT_OPEN' };
  }
  const { upsertCalendarEntryFromSource } = await import('./calendar-producers');
  const result = await upsertCalendarEntryFromSource(
    viewerId,
    { source_type: 'invite', source_ref_type: 'feed_post', source_ref_id: post.id },
    {
      title: String(snap.title ?? '').slice(0, CARD_TITLE_MAX) || 'Event',
      start_time: String(snap.start_time),
      end_time: snap.end_time ?? null,
      location: snap.location ?? null,
      emoji: snap.emoji ?? null,
      event_type: 'personal',
      role_context: 'community',
      metadata: { shared_by: post.user_id, post_id: post.id },
    } as any,
  );
  if (result.action === 'failed') return { ok: false, status: 500, error: 'CALENDAR_FAILED' };
  return { ok: true, action: result.action === 'unchanged' ? 'already' : 'added', event_id: (result.event as { id?: string } | null)?.id ?? null };
}
