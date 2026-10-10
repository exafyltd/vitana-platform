/**
 * VTID-04918 — Vitana assistant parity for the calendar.
 *
 * The calendar's member actions, reachable from every assistant path through
 * the shared ORB_TOOL_REGISTRY (gateway live session via its default arm, the
 * LiveKit agent via POST /api/v1/orb/tool, text chat via gemini-operator):
 *
 *   - create_calendar_event          a new entry in the member's calendar
 *   - share_calendar_entry_to_feed   the Phase 2 share (VTID-04916)
 *   - invite_to_calendar_entry       the Phase 3 chat invite (VTID-04917)
 *
 * Every write runs the shared guard (checkCalendarWriteRequest): nothing
 * happens until the member has confirmed (`confirmed === true`) and the event
 * has not passed. The live session additionally requires that the member has
 * spoken (memberHasSpoken, enforced in orb-live.ts — only it has that state).
 *
 * Results are facts and STATUS lines for the model, never sentences to speak
 * (NEVER rule 41): the model words the read-back and the outcome itself, in
 * the member's language.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { checkCalendarWriteRequest } from '../../orb/live/tools/calendar-write-guard';
import { createCalendarEvent, checkConflicts, getOwnCalendarEvent } from '../calendar-service';
import { toWritableRoleContext } from '../../types/calendar';
import { isShareableEntry, shareCalendarEntryToFeed, shareRefOf, SHARE_TEXT_MAX } from '../calendar-share';
import { buildInviteFromEntry, CALENDAR_INVITE_TYPE } from '../calendar-invite';
import { emitOasisEvent } from '../oasis-event-service';
import { disambiguationResult, fmtWhen, resolveEvent, resolveTimezone } from './calendar-management-tools';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

const VTID = 'VTID-04918';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_DURATION_MIN = 60;

/** Tools that write on the member's behalf — the live session gates them on memberHasSpoken. */
export const CALENDAR_SOCIAL_WRITE_TOOLS: readonly string[] = [
  'create_calendar_event',
  'share_calendar_entry_to_feed',
  'invite_to_calendar_entry',
];

function strArg(args: OrbToolArgs, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

function needsUser(tool: string, id: OrbToolIdentity): OrbToolResult | null {
  return id?.user_id ? null : { ok: false, error: `${tool} requires an authenticated user.` };
}

interface OwnEntry {
  id: string;
  user_id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  location: string | null;
  status: string;
  source_type: string;
  source_ref_type: string | null;
  source_ref_id: string | null;
  rrule: string | null;
}

type EntryLookup = { kind: 'entry'; entry: OwnEntry } | { kind: 'reply'; reply: OrbToolResult };

/** One of the member's own entries, by entry_id or title_query. */
async function findOwnEntry(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient, tz: string): Promise<EntryLookup> {
  const resolved = await resolveEvent({ ...args, event_id: strArg(args, 'entry_id') || strArg(args, 'event_id') }, id, sb);
  if (resolved.kind === 'error') return { kind: 'reply', reply: { ok: false, error: resolved.message } };
  if (resolved.kind === 'ambiguous') return { kind: 'reply', reply: disambiguationResult(resolved.matches, tz) };
  if (resolved.kind === 'none') {
    return { kind: 'reply', reply: { ok: true, result: { found: false }, text: 'STATUS: not_found. No matching entry is on the member\'s calendar.' } };
  }
  const entry = (await getOwnCalendarEvent(resolved.event.id, id.user_id)) as unknown as OwnEntry | null;
  if (!entry) {
    return { kind: 'reply', reply: { ok: true, result: { found: false }, text: 'STATUS: not_found. No matching entry is on the member\'s calendar.' } };
  }
  return { kind: 'entry', entry };
}

// ---------------------------------------------------------------------------
// create_calendar_event
// ---------------------------------------------------------------------------

export async function tool_create_calendar_event(args: OrbToolArgs, id: OrbToolIdentity): Promise<OrbToolResult> {
  const gate = needsUser('create_calendar_event', id);
  if (gate) return gate;
  const title = strArg(args, 'title');
  const start = strArg(args, 'start_time') || strArg(args, 'when_iso');
  if (!title || !start) {
    return { ok: false, error: 'create_calendar_event needs a title and a start_time (ISO 8601). Ask the member for what is missing.' };
  }
  const refusal = checkCalendarWriteRequest({ confirmed: args.confirmed, startTime: start, nowMs: Date.now() });
  if (refusal) {
    return { ok: true, result: { stage: 'awaiting_confirmation', created: false, title, start_time: start }, text: refusal };
  }

  const startMs = Date.parse(start);
  const explicitEnd = Date.parse(strArg(args, 'end_time'));
  const minutes = Number(args.duration_min);
  const endMs = Number.isFinite(explicitEnd) && explicitEnd > startMs
    ? explicitEnd
    : startMs + (Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 24 * 60) : DEFAULT_DURATION_MIN) * 60_000;
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const roleContext = toWritableRoleContext(id.role);

  try {
    const conflicts = await checkConflicts(id.user_id, roleContext, startIso, endIso).catch(() => []);
    const event = await createCalendarEvent(id.user_id, {
      title,
      start_time: startIso,
      end_time: endIso,
      description: strArg(args, 'description') || undefined,
      location: strArg(args, 'location') || undefined,
      event_type: (strArg(args, 'event_type') || 'personal') as never,
      status: 'confirmed',
      priority: 'medium',
      role_context: roleContext,
      source_type: 'assistant',
      priority_score: 50,
      wellness_tags: [],
      metadata: { created_via: 'orb_tool' },
      is_recurring: false,
    });
    if (!event) return { ok: false, error: 'STATUS: not_created. The calendar did not accept the entry. Tell the member it did not go through.' };
    emitOasisEvent({
      vtid: VTID,
      type: 'calendar.event.created' as never,
      source: 'orb-tools',
      status: 'info',
      message: `Assistant-created calendar event: ${event.title}`,
      payload: { event_id: event.id, user_id: id.user_id, via: 'assistant' },
    }).catch(() => {});
    const tz = resolveTimezone(args);
    return {
      ok: true,
      result: { created: true, event_id: event.id, title: event.title, start_time: startIso, end_time: endIso, conflicts: conflicts.length },
      text: `STATUS: created. "${event.title}" ${fmtWhen(startIso, tz)}${conflicts.length ? `; overlaps ${conflicts.length} other entr${conflicts.length === 1 ? 'y' : 'ies'}` : ''}.`,
    };
  } catch (err) {
    return { ok: false, error: `create_calendar_event failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// share_calendar_entry_to_feed
// ---------------------------------------------------------------------------

const SHARE_REFUSAL: Record<string, string> = {
  NOT_FOUND: 'STATUS: not_found. That entry is not on the member\'s calendar.',
  NOT_SHAREABLE: 'STATUS: not_shareable. Only an upcoming community event or live room the member takes part in can be shared to the feed.',
  ALREADY_SHARED: 'STATUS: already_shared. The member has already shared this event to the feed.',
  DUPLICATE_POST: 'STATUS: duplicate_post. The member posted the same text moments ago.',
  SHARE_LIMIT: 'STATUS: share_limit. The member has reached today\'s limit for sharing events.',
  RATE_LIMITED: 'STATUS: rate_limited. Posting is paused for the member for now.',
  USER_SUSPENDED: 'STATUS: not_allowed. The member cannot post right now.',
};

export async function tool_share_calendar_entry_to_feed(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = needsUser('share_calendar_entry_to_feed', id);
  if (gate) return gate;
  try {
    const tz = resolveTimezone(args);
    const found = await findOwnEntry(args, id, sb, tz);
    if (found.kind === 'reply') return found.reply;
    const entry = found.entry;
    if (!isShareableEntry(entry)) {
      const reason = !shareRefOf(entry) ? 'private_entry' : entry.status === 'cancelled' ? 'cancelled' : 'past';
      return { ok: true, result: { shared: false, reason }, text: SHARE_REFUSAL.NOT_SHAREABLE };
    }
    const text = strArg(args, 'text').slice(0, SHARE_TEXT_MAX);
    const isPublic = args.is_public !== false;

    if (args.confirmed !== true) {
      return {
        ok: true,
        result: { stage: 'awaiting_confirmation', entry_id: entry.id, title: entry.title, start_time: entry.start_time, text, is_public: isPublic },
        text:
          'STATUS: needs_confirmation. Nothing was posted. Read the event and the post text back to the member in your own words ' +
          'and ask whether to post it; call again with the same entry_id and text and confirmed=true only after they say yes.',
      };
    }
    const refusal = checkCalendarWriteRequest({ confirmed: true, startTime: entry.start_time, endTime: entry.end_time, nowMs: Date.now() });
    if (refusal) return { ok: true, result: { shared: false, reason: 'past' }, text: SHARE_REFUSAL.NOT_SHAREABLE };

    const r = await shareCalendarEntryToFeed(id.user_id, entry as never, { text, is_public: isPublic });
    if (!r.ok) {
      return {
        ok: true,
        result: { shared: false, error: r.error, ...(r.reason ? { reason: r.reason } : {}), ...(r.post_id ? { post_id: r.post_id } : {}) },
        text: SHARE_REFUSAL[r.error] ?? 'STATUS: not_shared. The post did not go through. Tell the member honestly.',
      };
    }
    emitOasisEvent({
      vtid: VTID,
      type: 'calendar.shared_to_feed' as never,
      source: 'orb-tools',
      status: 'info',
      message: `Calendar entry shared to the feed by the assistant (${r.ref.ref_type})`,
      payload: { user_id: id.user_id, entry_id: entry.id, post_id: r.post_id, ref_type: r.ref.ref_type, ref_id: r.ref.ref_id, via: 'assistant' },
    }).catch(() => {});
    return {
      ok: true,
      result: { shared: true, post_id: r.post_id, title: entry.title },
      text: `STATUS: shared. "${entry.title}" is on the member's feed.`,
    };
  } catch (err) {
    return { ok: false, error: `share_calendar_entry_to_feed failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// invite_to_calendar_entry
// ---------------------------------------------------------------------------

const INVITE_REFUSAL: Record<string, string> = {
  NOT_FOUND: 'STATUS: not_found. That entry is not on the member\'s calendar.',
  NOT_INVITABLE:
    'STATUS: not_invitable. Only an upcoming community event, live room, or the member\'s own one-off entry can be shared as an invite — never a series, a finished or cancelled entry, or one another feature owns.',
};

export async function tool_invite_to_calendar_entry(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = needsUser('invite_to_calendar_entry', id);
  if (gate) return gate;
  const recipientId = strArg(args, 'recipient_user_id');
  if (!UUID_RE.test(recipientId)) {
    return { ok: false, error: 'invite_to_calendar_entry needs recipient_user_id from resolve_recipient. Resolve the person first.' };
  }
  if (recipientId === id.user_id) {
    return { ok: false, error: 'The member cannot invite themselves.' };
  }
  try {
    const tz = resolveTimezone(args);
    const found = await findOwnEntry(args, id, sb, tz);
    if (found.kind === 'reply') return found.reply;
    const entry = found.entry;

    const invite = await buildInviteFromEntry(id.user_id, entry as never);
    if (!invite.ok) {
      return {
        ok: true,
        result: { invited: false, error: invite.error, ...(invite.reason ? { reason: invite.reason } : {}) },
        text: INVITE_REFUSAL[invite.error] ?? 'STATUS: not_invitable. This entry cannot be shared as an invite.',
      };
    }

    const { data: receiver, error: receiverErr } = await sb
      .from('app_users')
      .select('user_id, display_name, vitana_id, tenant_id')
      .eq('user_id', recipientId)
      .maybeSingle();
    if (receiverErr) return { ok: false, error: `invite_to_calendar_entry failed: ${receiverErr.message}` };
    if (!receiver) {
      return { ok: true, result: { invited: false, error: 'RECIPIENT_NOT_FOUND' }, text: 'STATUS: recipient_not_found. That person is not in the community.' };
    }
    const recipient = receiver as { user_id: string; display_name: string | null; vitana_id: string | null };
    const recipientName = recipient.display_name || recipient.vitana_id || '';

    if (args.confirmed !== true) {
      return {
        ok: true,
        result: {
          stage: 'awaiting_confirmation',
          entry_id: entry.id,
          title: invite.metadata.title,
          start_time: invite.metadata.start_time,
          recipient_user_id: recipientId,
          recipient_name: recipientName,
        },
        text:
          'STATUS: needs_confirmation. Nothing was sent. Tell the member, in your own words, which entry goes to whom and ask whether to send the invite; ' +
          'call again with the same entry_id and recipient_user_id and confirmed=true only after they say yes.',
      };
    }
    const refusal = checkCalendarWriteRequest({ confirmed: true, startTime: entry.start_time, endTime: entry.end_time, nowMs: Date.now() });
    if (refusal) return { ok: true, result: { invited: false, reason: 'past' }, text: INVITE_REFUSAL.NOT_INVITABLE };

    let tenantId = id.tenant_id;
    if (!tenantId) {
      const { data: me } = await sb.from('app_users').select('tenant_id').eq('user_id', id.user_id).maybeSingle();
      tenantId = (me as { tenant_id?: string } | null)?.tenant_id ?? null;
    }
    if (!tenantId) return { ok: false, error: 'invite_to_calendar_entry: the member\'s tenant is unknown.' };

    const sessionKey = (id.session_id ?? '').trim() || `${id.user_id}:invite_to_calendar_entry:no_session`;
    const { checkVoiceSendQuota } = await import('../voice-message-guard');
    const quota = await checkVoiceSendQuota({
      session_id: sessionKey,
      actor_id: id.user_id,
      vitana_id: id.vitana_id ?? null,
      recipient_user_id: recipientId,
      recipient_vitana_id: recipient.vitana_id,
      kind: 'message',
      body_length: invite.content.length,
      key_type: id.session_id ? 'real_session' : 'missing_session_fallback',
    });
    if (!quota.allowed) {
      return { ok: true, result: { invited: false, rate_limited: true }, text: 'STATUS: rate_limited. Too many sends in this conversation; try again later.' };
    }

    const { data: inserted, error: insErr } = await sb
      .from('chat_messages')
      .insert({
        tenant_id: tenantId,
        sender_id: id.user_id,
        receiver_id: recipientId,
        content: invite.content,
        message_type: CALENDAR_INVITE_TYPE,
        metadata: { ...invite.metadata },
        ...(id.vitana_id ? { sender_vitana_id: id.vitana_id } : {}),
        ...(recipient.vitana_id ? { receiver_vitana_id: recipient.vitana_id } : {}),
      })
      .select('id')
      .single();
    if (insErr) return { ok: false, error: `STATUS: not_sent. The invite did not go through (${insErr.message}).` };
    const messageId = (inserted as { id?: string } | null)?.id ?? null;

    // Same push as POST /api/v1/chat/send (routes/chat.ts): sender name as the
    // title, the card's one-line content as the body, deep link to the thread.
    try {
      const { notifyUser } = await import('../notification-service');
      const { data: me } = await sb.from('app_users').select('display_name, email').eq('user_id', id.user_id).maybeSingle();
      const senderName = (me as { display_name?: string | null } | null)?.display_name
        || ((me as { email?: string | null } | null)?.email ?? '').split('@')[0]
        || 'New message';
      await notifyUser(
        recipientId,
        tenantId,
        'new_chat_message',
        {
          title: senderName,
          body: invite.content.length > 100 ? invite.content.slice(0, 97) + '...' : invite.content,
          data: {
            type: 'new_chat_message',
            sender_id: id.user_id,
            sender_name: senderName,
            message_id: messageId ?? '',
            thread_id: id.user_id,
            url: `/inbox/u/${id.user_id}`,
          },
        },
        sb,
      );
    } catch (err) {
      console.error('[calendar-social-tools] invite push failed:', (err as Error).message);
    }

    emitOasisEvent({
      vtid: VTID,
      type: 'calendar.invite.sent' as never,
      source: 'orb-tools',
      status: 'info',
      message: `Calendar invite sent by the assistant (${invite.metadata.ref_type})`,
      payload: { user_id: id.user_id, recipient_user_id: recipientId, message_id: messageId, entry_id: entry.id, ref_type: invite.metadata.ref_type, via: 'assistant' },
    }).catch(() => {});
    return {
      ok: true,
      result: { invited: true, message_id: messageId, title: invite.metadata.title, recipient_name: recipientName },
      text: `STATUS: sent. The invite to "${invite.metadata.title}" is in the chat with ${recipientName}.`,
    };
  } catch (err) {
    return { ok: false, error: `invite_to_calendar_entry failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const CALENDAR_SOCIAL_TOOL_HANDLERS: Record<string, Handler> = {
  create_calendar_event: (args, id) => tool_create_calendar_event(args, id),
  share_calendar_entry_to_feed: tool_share_calendar_entry_to_feed,
  invite_to_calendar_entry: tool_invite_to_calendar_entry,
};

const ENTRY_PROPS = {
  entry_id: { type: 'string', description: 'The calendar entry id (UUID), if known.' },
  title_query: { type: 'string', description: 'Fuzzy title to find the member\'s entry when entry_id is unknown.' },
  timezone: { type: 'string', description: 'IANA timezone for times, e.g. "Europe/Berlin".' },
};

/**
 * Declarations for the two new tools. create_calendar_event is already
 * declared by the live catalog (live-tool-catalog.ts) and the LiveKit agent;
 * its shared handler above is what those callers now reach.
 */
export const CALENDAR_SOCIAL_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'share_calendar_entry_to_feed',
    description: [
      'Share an upcoming community event or live room from the member\'s calendar to their community feed, as a post with the event card.',
      'WHEN TO CALL: "post my yoga meetup to the feed", "tell everyone I\'m going", "Teil das Event im Feed".',
      'Only events and live rooms can be shared — never a private entry. The member must ask for it.',
      'Compose a short, friendly post text in the member\'s language (du-form in German) or use their words.',
      'Two steps: call without confirmed to get the preview; read the event and the post text back and ask;',
      'call again with the same entry_id and text and confirmed=true only after the member says yes. Never claim it was posted unless the result says STATUS: shared.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        ...ENTRY_PROPS,
        text: { type: 'string', description: 'The post text, in the member\'s language (max 2000 characters). May be empty.' },
        is_public: { type: 'boolean', description: 'false to keep the post visible to the member only. Defaults to public.' },
        confirmed: { type: 'boolean', description: 'true ONLY after the member explicitly confirmed the read-back.' },
      },
      required: [],
    },
  },
  {
    name: 'invite_to_calendar_entry',
    description: [
      'Invite another community member to an entry in the member\'s calendar: sends an invite card into their direct chat, which they answer with yes / maybe / no.',
      'WHEN TO CALL: "invite Maria to my run on Saturday", "Lad Jonas zum Meetup ein".',
      'Works for an upcoming community event, live room, or the member\'s own one-off entry — not a series, nothing finished or cancelled.',
      'First resolve the person with resolve_recipient and pass their user id as recipient_user_id.',
      'Two steps: call without confirmed to get the preview; tell the member which entry goes to whom and ask;',
      'call again with the same arguments and confirmed=true only after they say yes. Never claim it was sent unless the result says STATUS: sent.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        ...ENTRY_PROPS,
        recipient_user_id: { type: 'string', description: 'The invited person\'s user id (UUID) from resolve_recipient.' },
        confirmed: { type: 'boolean', description: 'true ONLY after the member explicitly confirmed.' },
      },
      required: ['recipient_user_id'],
    },
  },
];

// ---------------------------------------------------------------------------
// Text chat (gemini-operator) — VTID-04918
// ---------------------------------------------------------------------------

export interface TextToolDeclaration {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

function asTextDeclaration(d: Record<string, unknown>, extra: string[] = [], extraProps: Record<string, unknown> = {}): TextToolDeclaration {
  const params = d.parameters as { properties: Record<string, unknown>; required?: string[] };
  return {
    name: String(d.name),
    description: [String(d.description), ...extra].join('\n'),
    parameters: { type: 'object', properties: { ...params.properties, ...extraProps }, required: params.required ?? [] },
  };
}

/** The calendar write tools text chat offers; each runs through the shared registry. */
export const CALENDAR_TEXT_TOOL_NAMES: readonly string[] = [
  'create_calendar_event',
  'reschedule_event',
  'cancel_event',
  'share_calendar_entry_to_feed',
  'invite_to_calendar_entry',
];

/**
 * Text chat moves an event only after the member confirmed it (the voice
 * paths keep their own one-step reschedule). Returns the refusal, or null.
 */
export function textCalendarConfirmation(name: string, args: OrbToolArgs): string | null {
  if (name === 'reschedule_event' && args.confirmed !== true) {
    return 'STATUS: needs_confirmation. Nothing was moved. Tell the member which entry moves to which day and time and ask; call again with confirmed=true only after they say yes.';
  }
  return null;
}

/** Built lazily so the voice declarations stay the single source. */
export function calendarTextToolDeclarations(mgmt: Array<Record<string, unknown>>): TextToolDeclaration[] {
  const byName = new Map(mgmt.map((d) => [String(d.name), d]));
  const out: TextToolDeclaration[] = [
    {
      name: 'create_calendar_event',
      description: [
        'Add a new entry to the member\'s own calendar.',
        'WHEN TO CALL: "put yoga on Friday at 6 pm in my calendar", "Trag mir morgen 10 Uhr Zahnarzt ein".',
        'Two steps: call without confirmed to check; read the title, date and time back and ask;',
        'call again with confirmed=true only after the member says yes. Never in the past.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Entry title, in the member\'s words.' },
          start_time: { type: 'string', description: 'Start, ISO 8601 with offset (e.g. "2026-10-12T18:00:00+02:00").' },
          end_time: { type: 'string', description: 'Optional end, ISO 8601.' },
          duration_min: { type: 'integer', description: 'Optional duration in minutes when no end_time (default 60).' },
          description: { type: 'string', description: 'Optional notes.' },
          location: { type: 'string', description: 'Optional place.' },
          confirmed: { type: 'boolean', description: 'true ONLY after the member confirmed the read-back.' },
        },
        required: ['title', 'start_time'],
      },
    },
  ];
  const reschedule = byName.get('reschedule_event');
  if (reschedule) {
    out.push(asTextDeclaration(
      reschedule,
      ['In text chat: call without confirmed first, ask the member, then call again with confirmed=true.'],
      { confirmed: { type: 'boolean', description: 'true ONLY after the member confirmed the new time.' } },
    ));
  }
  const cancel = byName.get('cancel_event');
  if (cancel) out.push(asTextDeclaration(cancel));
  for (const d of CALENDAR_SOCIAL_TOOL_DECLARATIONS) out.push(asTextDeclaration(d));
  return out;
}
