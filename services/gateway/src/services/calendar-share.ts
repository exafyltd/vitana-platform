/**
 * VTID-04916 — share a calendar entry to the news feed.
 *
 * A member who is going to a community event (or a live room session) can
 * post it to the feed from the calendar. The post is an ordinary
 * `profile_posts` row with an attached reference
 * (attached_ref_type / attached_ref_id, migration in vitana-v1), so the feed
 * renders a live event card under the member's own words.
 *
 * Rules (plan VTID-04914..04918, sparred, owner-approved 2026-10-06):
 *   - Only entries whose source is a community event or a live room session
 *     can be shared. Health plans, lab orders, appointments, goal plans,
 *     journeys, Autopilot steps and private entries never can.
 *   - The event must still exist, not be cancelled, and not be over.
 *   - user_id comes from the verified JWT only; the caller never names it.
 *     The gateway writes with the service role, so this is the ownership
 *     check RLS would otherwise do.
 *   - One share per member per event (unique index); a second attempt
 *     answers 409 ALREADY_SHARED with the existing post id.
 *   - At most SHARE_LIMIT_PER_DAY event shares per member per 24 h (429).
 *   - Notifications are the database's job (trg_notify_community_post),
 *     deduplicated per recipient per event per 24 h.
 */
import { getSupabaseConfig, headers } from './calendar-service';

const LOG_PREFIX = '[CalendarShare]';

export type ShareRefType = 'community_event' | 'live_room_session';
export const SHARE_LIMIT_PER_DAY = 5;
export const SHARE_TEXT_MAX = 2000;

export interface ShareRef {
  ref_type: ShareRefType;
  ref_id: string;
}

interface EntryLike {
  id?: string;
  user_id?: string;
  status?: string | null;
  source_ref_type?: string | null;
  source_ref_id?: string | null;
  metadata?: Record<string, unknown> | null;
  end_time?: string | null;
  start_time?: string | null;
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
 * Cheap check for the calendar window: does this entry point at something
 * shareable that has not ended? The full check (event exists, not cancelled)
 * runs on submit.
 */
export function isShareableEntry(entry: EntryLike | null | undefined, now: Date = new Date()): boolean {
  if (!entry || entry.status === 'cancelled') return false;
  if (!shareRefOf(entry)) return false;
  const end = Date.parse(entry.end_time || entry.start_time || '');
  return Number.isFinite(end) && end > now.getTime();
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

export interface ShareInput {
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
  if (entry.status === 'cancelled') return { ok: false, status: 409, error: 'NOT_SHAREABLE', reason: 'cancelled' };
  const ref = shareRefOf(entry);
  if (!ref) return { ok: false, status: 409, error: 'NOT_SHAREABLE', reason: 'private_entry' };

  const config = getSupabaseConfig();
  if (!config) return { ok: false, status: 503, error: 'NOT_CONFIGURED' };

  const existing = await listSharedPostIds(userId, [ref.ref_id]);
  const already = existing.get(ref.ref_id);
  if (already) return { ok: false, status: 409, error: 'ALREADY_SHARED', post_id: already };

  const target = await checkShareTarget(ref, now);
  if (!target.ok) return { ok: false, status: 409, error: 'NOT_SHAREABLE', reason: target.reason };

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
