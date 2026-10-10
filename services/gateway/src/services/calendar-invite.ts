/**
 * VTID-04917 — invite someone to a calendar entry through the messenger.
 *
 * A member opens an entry in their calendar, taps Invite and picks a direct
 * chat or a group. The message is an ordinary chat_messages row of type
 * `calendar_invite`; this file builds its metadata on the server from the
 * sender's OWN entry, so a client can never send an invite card for an event
 * that is private, over, cancelled or not theirs, and never forge the title
 * or time on the card.
 *
 * What can be invited to:
 *   - a community event or a live room session the member is going to
 *     (the same rules as sharing to the feed, VTID-04916);
 *   - the member's own one-off entry they made themselves (manual / invite).
 * Never: health plans, lab orders, appointments, plans, journeys, Autopilot,
 * subscriptions, reminders, audiobook, or a recurring entry.
 *
 * What Accept does:
 *   - community event → the recipient joins the event through the same row
 *     the app writes (global_event_participants); the database puts it in
 *     their calendar (trg_event_participation_calendar). A paid or full
 *     event is never joined from a chat card: the app opens the event page,
 *     where tickets and the waiting list live.
 *   - live room session → the app opens the room (tickets / reminders live
 *     there).
 *   - own entry → a copy in the recipient's calendar
 *     (source_type 'invite', source_ref_type 'calendar_invite',
 *     source_ref_id = the message id); Decline removes it again.
 * Every answer is recorded in calendar_invite_responses (one per member per
 * message), so the card shows it and the sender sees who is coming.
 */
import { getSupabaseConfig, headers, getOwnCalendarEvent } from './calendar-service';
import { checkShareTarget, shareRefOf } from './calendar-share';
import { upsertCalendarEntryFromSource, cancelCalendarEntriesForSource } from './calendar-producers';

const LOG_PREFIX = '[CalendarInvite]';

export const CALENDAR_INVITE_TYPE = 'calendar_invite';
export const INVITE_METADATA_VERSION = 2;
export const INVITE_RESPONSES = ['accepted', 'maybe', 'declined'] as const;
export type InviteResponse = (typeof INVITE_RESPONSES)[number];
export type InviteRefType = 'community_event' | 'live_room_session' | 'calendar_entry';

const INVITABLE_OWN_SOURCES = new Set(['manual', 'invite']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 3_600_000;

export interface InviteMetadata {
  kind: 'calendar_invite';
  v: typeof INVITE_METADATA_VERSION;
  ref_type: InviteRefType;
  ref_id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  location: string | null;
}

export type BuildInviteResult =
  | { ok: true; metadata: InviteMetadata; content: string }
  | { ok: false; status: number; error: string; reason?: string };

interface EntryLike {
  id?: string;
  user_id?: string;
  title?: string | null;
  status?: string | null;
  source_type?: string | null;
  source_ref_type?: string | null;
  source_ref_id?: string | null;
  metadata?: Record<string, unknown> | null;
  start_time?: string | null;
  end_time?: string | null;
  location?: string | null;
  rrule?: string | null;
}

function endOf(start: string | null | undefined, end: string | null | undefined): number {
  const e = Date.parse(end || '');
  if (Number.isFinite(e)) return e;
  const s = Date.parse(start || '');
  return Number.isFinite(s) ? s + HOUR_MS : NaN;
}

/**
 * The invite card for one of the sender's own entries, built on the server.
 * `entry` must be the sender's own row (load it with getOwnCalendarEvent).
 */
export async function buildInviteFromEntry(
  senderId: string,
  entry: EntryLike | null,
  now: Date = new Date(),
): Promise<BuildInviteResult> {
  if (!entry || entry.user_id !== senderId) return { ok: false, status: 404, error: 'NOT_FOUND' };
  if (entry.status === 'cancelled') return { ok: false, status: 409, error: 'NOT_INVITABLE', reason: 'cancelled' };
  if (!(endOf(entry.start_time, entry.end_time) > now.getTime())) {
    return { ok: false, status: 409, error: 'NOT_INVITABLE', reason: 'past' };
  }

  const ref = shareRefOf(entry);
  if (ref) {
    const target = await checkShareTarget(ref, now);
    if (!target.ok) return { ok: false, status: 409, error: 'NOT_INVITABLE', reason: target.reason };
    const metadata: InviteMetadata = {
      kind: 'calendar_invite',
      v: INVITE_METADATA_VERSION,
      ref_type: ref.ref_type,
      ref_id: ref.ref_id,
      title: target.title || entry.title || '',
      start_time: String(entry.start_time),
      end_time: entry.end_time ?? null,
      location: entry.location ?? null,
    };
    return { ok: true, metadata, content: `📅 ${metadata.title}`.trim() };
  }

  if (!INVITABLE_OWN_SOURCES.has(String(entry.source_type)) || entry.rrule) {
    return { ok: false, status: 409, error: 'NOT_INVITABLE', reason: entry.rrule ? 'recurring' : 'private_entry' };
  }
  const metadata: InviteMetadata = {
    kind: 'calendar_invite',
    v: INVITE_METADATA_VERSION,
    ref_type: 'calendar_entry',
    ref_id: String(entry.id),
    title: entry.title || '',
    start_time: String(entry.start_time),
    end_time: entry.end_time ?? null,
    location: entry.location ?? null,
  };
  return { ok: true, metadata, content: `📅 ${metadata.title}`.trim() };
}

/**
 * What the chat send routes store for a `calendar_invite`: the client sends
 * only `{ entry_id }`; everything on the card comes from the sender's entry.
 */
export async function buildInviteForChat(
  senderId: string,
  contentData: unknown,
  now: Date = new Date(),
): Promise<BuildInviteResult> {
  const entryId = contentData && typeof contentData === 'object' ? (contentData as Record<string, unknown>).entry_id : null;
  if (typeof entryId !== 'string' || !UUID_RE.test(entryId)) {
    return { ok: false, status: 400, error: 'entry_id_required' };
  }
  const entry = await getOwnCalendarEvent(entryId, senderId);
  return buildInviteFromEntry(senderId, entry as EntryLike | null, now);
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

async function getRows<T>(path: string): Promise<T[] | null> {
  const config = getSupabaseConfig();
  if (!config) return null;
  const resp = await fetch(`${config.url}/rest/v1/${path}`, { headers: headers(config.key) });
  if (!resp.ok) {
    console.error(`${LOG_PREFIX} GET ${path.split('?')[0]} failed: ${resp.status}`);
    return null;
  }
  return (await resp.json()) as T[];
}

interface InviteMessage {
  id: string;
  sender_id: string;
  receiver_id: string | null;
  group_id: string | null;
  message_type: string;
  metadata: Record<string, unknown> | null;
}

export function inviteMetadataOf(m: InviteMessage | null): InviteMetadata | null {
  if (!m || m.message_type !== CALENDAR_INVITE_TYPE) return null;
  const md = (m.metadata ?? {}) as Record<string, unknown>;
  if (md.v !== INVITE_METADATA_VERSION) return null;
  const refType = md.ref_type;
  if (refType !== 'community_event' && refType !== 'live_room_session' && refType !== 'calendar_entry') return null;
  if (typeof md.ref_id !== 'string' || !UUID_RE.test(md.ref_id) || typeof md.start_time !== 'string') return null;
  return md as unknown as InviteMetadata;
}

/** The invite message, if this member may see it: the sender, the DM recipient, or a member of the group. */
async function loadVisibleInvite(
  userId: string,
  messageId: string,
): Promise<{ message: InviteMessage; invite: InviteMetadata } | null> {
  if (!UUID_RE.test(messageId)) return null;
  const rows = await getRows<InviteMessage>(
    `chat_messages?id=eq.${encodeURIComponent(messageId)}&select=id,sender_id,receiver_id,group_id,message_type,metadata&limit=1`,
  );
  const message = rows?.[0] ?? null;
  const invite = inviteMetadataOf(message);
  if (!message || !invite) return null;
  if (message.sender_id === userId || message.receiver_id === userId) return { message, invite };
  if (message.group_id) {
    const members = await getRows<{ user_id: string }>(
      `chat_group_members?group_id=eq.${encodeURIComponent(message.group_id)}&user_id=eq.${encodeURIComponent(userId)}&select=user_id&limit=1`,
    );
    if (members?.length) return { message, invite };
  }
  return null;
}

async function isPaidOrFull(eventId: string): Promise<boolean> {
  const events = await getRows<{ metadata: Record<string, unknown> | null; max_participants: number | null }>(
    `global_community_events?id=eq.${encodeURIComponent(eventId)}&select=metadata,max_participants&limit=1`,
  );
  const ev = events?.[0];
  if (!ev) return true; // unknown → let the event page decide
  if (ev.metadata && (ev.metadata as Record<string, unknown>).is_paid === true) return true;
  if (!(ev.metadata && (ev.metadata as Record<string, unknown>).is_paid === false)) {
    const tickets = await getRows<{ price: number | string | null }>(
      `event_ticket_types?event_id=eq.${encodeURIComponent(eventId)}&select=price`,
    );
    if (tickets === null) return true;
    if (tickets.some((t) => Number(t.price) > 0)) return true;
  }
  if (ev.max_participants && ev.max_participants > 0) {
    const attending = await getRows<{ user_id: string }>(
      `global_event_participants?event_id=eq.${encodeURIComponent(eventId)}&status=eq.attending&select=user_id`,
    );
    if (attending === null || attending.length >= ev.max_participants) return true;
  }
  return false;
}

async function write(path: string, body: unknown, prefer: string): Promise<boolean> {
  const config = getSupabaseConfig();
  if (!config) return false;
  const resp = await fetch(`${config.url}/rest/v1/${path}`, {
    method: 'POST',
    headers: headers(config.key, { Prefer: prefer }),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error(`${LOG_PREFIX} POST ${path.split('?')[0]} failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    return false;
  }
  return true;
}

export type InviteAction = 'joined' | 'open_event' | 'open_room' | 'added' | 'removed' | 'recorded';

export type RespondResult =
  | { ok: true; response: InviteResponse; action: InviteAction; path?: string }
  | { ok: false; status: number; error: string };

export function eventPath(eventId: string): string {
  return `/comm/events-meetups?event=${encodeURIComponent(eventId)}`;
}

/**
 * Records a member's answer to an invite and acts on it. `userId` is the
 * verified caller; they must be the DM recipient or a member of the group,
 * never the sender.
 */
export async function respondToInvite(
  userId: string,
  messageId: string,
  response: InviteResponse,
  now: Date = new Date(),
): Promise<RespondResult> {
  if (!getSupabaseConfig()) return { ok: false, status: 503, error: 'NOT_CONFIGURED' };
  const found = await loadVisibleInvite(userId, messageId);
  if (!found) return { ok: false, status: 404, error: 'NOT_FOUND' };
  const { message, invite } = found;
  if (message.sender_id === userId) return { ok: false, status: 409, error: 'OWN_INVITE' };

  const recorded = await write(
    'calendar_invite_responses?on_conflict=message_id,user_id',
    { message_id: message.id, user_id: userId, response, responded_at: now.toISOString() },
    'resolution=merge-duplicates,return=minimal',
  );
  if (!recorded) return { ok: false, status: 500, error: 'RECORD_FAILED' };

  if (invite.ref_type === 'calendar_entry') {
    if (response === 'declined') {
      await cancelCalendarEntriesForSource(userId, 'calendar_invite', message.id);
      return { ok: true, response, action: 'removed' };
    }
    if (response === 'maybe') return { ok: true, response, action: 'recorded' };
    const result = await upsertCalendarEntryFromSource(
      userId,
      { source_type: 'invite', source_ref_type: 'calendar_invite', source_ref_id: message.id },
      {
        title: invite.title || 'Invite',
        start_time: invite.start_time,
        end_time: invite.end_time,
        location: invite.location,
        event_type: 'personal',
        role_context: 'community',
        metadata: { invited_by: message.sender_id, message_id: message.id },
      } as any,
    );
    if (result.action === 'failed') return { ok: false, status: 500, error: 'CALENDAR_FAILED' };
    return { ok: true, response, action: 'added' };
  }

  if (response !== 'accepted') return { ok: true, response, action: 'recorded' };

  // An event that is over or gone is not joined, whatever the card says.
  const target = await checkShareTarget({ ref_type: invite.ref_type, ref_id: invite.ref_id }, now);
  if (!target.ok) return { ok: false, status: 409, error: 'EVENT_NOT_OPEN' };

  if (invite.ref_type === 'live_room_session') {
    const sessions = await getRows<{ room_id: string | null }>(
      `live_room_sessions?id=eq.${encodeURIComponent(invite.ref_id)}&select=room_id&limit=1`,
    );
    const roomId = sessions?.[0]?.room_id;
    if (!roomId) return { ok: false, status: 409, error: 'EVENT_NOT_OPEN' };
    return { ok: true, response, action: 'open_room', path: `/comm/live-rooms/${encodeURIComponent(roomId)}/view` };
  }

  if (await isPaidOrFull(invite.ref_id)) {
    return { ok: true, response, action: 'open_event', path: eventPath(invite.ref_id) };
  }
  const joined = await write(
    'global_event_participants?on_conflict=event_id,user_id',
    { event_id: invite.ref_id, user_id: userId, status: 'attending' },
    'resolution=merge-duplicates,return=minimal',
  );
  if (!joined) return { ok: false, status: 500, error: 'JOIN_FAILED' };
  return { ok: true, response, action: 'joined', path: eventPath(invite.ref_id) };
}

export interface InviteState {
  my_response: InviteResponse | null;
  counts: Record<InviteResponse, number>;
  is_sender: boolean;
}

/** The viewer's own answer and how many said yes / maybe / no. */
export async function getInviteState(userId: string, messageId: string): Promise<InviteState | null> {
  const found = await loadVisibleInvite(userId, messageId);
  if (!found) return null;
  const rows = (await getRows<{ user_id: string; response: string }>(
    `calendar_invite_responses?message_id=eq.${encodeURIComponent(found.message.id)}&select=user_id,response`,
  )) ?? [];
  const counts: Record<InviteResponse, number> = { accepted: 0, maybe: 0, declined: 0 };
  let mine: InviteResponse | null = null;
  for (const r of rows) {
    if ((INVITE_RESPONSES as readonly string[]).includes(r.response)) {
      counts[r.response as InviteResponse] += 1;
      if (r.user_id === userId) mine = r.response as InviteResponse;
    }
  }
  return { my_response: mine, counts, is_sender: found.message.sender_id === userId };
}
