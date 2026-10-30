/**
 * Chat Messages API Routes — User-to-user direct messaging
 *
 * Endpoints:
 *   POST   /send               — Send a message to another user (never triggers a Vitana reply)
 *   POST   /vitana-reply       — Generate + await a Vitana bot reply (VTID-03470)
 *   GET    /conversation/:peer — Get messages between current user and peer (paginated)
 *   GET    /conversations      — List recent conversations (latest message per peer)
 *   POST   /read               — Mark messages from a peer as read
 *   POST   /delivered          — Mark received DMs as delivered (VTID-05310)
 *   POST   /viewing            — "viewing this conversation" heartbeat (VTID-05312, routes/chat-viewing.ts)
 *   GET    /unread-count       — Total unread message count
 *   GET    /search             — Message search in the caller's DMs and groups (VTID-05309, routes/chat-search.ts)
 *   GET    /shared-preview     — Card of a shared post/event/product/profile for the caller (VTID-05311)
 */

import { Router, Request, Response } from 'express';
import {
  requireAuth,
  requireTenant,
  resolveVitanaId,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { buildInviteForChat, CALENDAR_INVITE_TYPE } from '../services/calendar-invite';
import { createClient } from '@supabase/supabase-js';
import { notifyUser, type NotificationPayload, type NotifyUserOptions } from '../services/notification-service';
import { coalesceChatPushes, chatConversationKey } from '../services/chat-push-coalescer';
import { isNewMemberGreeting, prepareNewMemberGreetingPush } from '../services/new-member-greeting-push';
import { VITANA_BOT_USER_ID, isVitanaBot } from '../lib/vitana-bot';
import { processConversationTurn } from '../services/conversation-client';
import { extractDmActions } from '../services/chat/dm-tool-actions';
import { tt } from '../i18n/catalog';
import { checkInviteSend, inviteRefusedBody, INVITE_REFUSED_STATUS } from '../services/calendar-invite-guard';
import { checkGreetingSend, greetingRefusedBody, GREETING_REFUSED_STATUS, NEW_MEMBER_GREETING_SOURCE } from '../services/new-member-greeting-guard';
import { getUserLocale } from '../i18n/server-locale';
import * as repo from './chat-repository';
import chatSearchRouter from './chat-search';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { getBearerToken } from '../lib/tenant-role-auth';
import { SHARED_CONTENT_TYPE, SHARED_CAPTION_MAX, parseSharedRef, resolveSharedPreview, senderCanShare } from '../services/chat-shared-content';
import chatViewingRouter from './chat-viewing';
import { markCompanionRepliedInBackground } from '../services/companion/companion-repository';

const router = Router();

/**
 * VTID-05311: the send-side check of a shared item, shared by DM and group
 * send. 400 invalid ref / caption too long, 401 no token, 403 the sender cannot
 * see the item, 503 the check could not run. On success the item is stored as
 * `{ kind, id }` only (the route may add its own server-validated fields:
 * `reply_to`, a group's sanitized `mentions`). `content` is an optional
 * caption of the sender's own words (≤ 1000 characters), never item data.
 */
export async function checkSharedContentSend(
  req: Request,
  contentData: unknown,
  caption = '',
): Promise<{ ok: true; metadata: { kind: string; id: string } } | { ok: false; status: number; error: string }> {
  const ref = parseSharedRef(contentData);
  if (!ref) return { ok: false, status: 400, error: 'invalid_shared_content' };
  if (caption.length > SHARED_CAPTION_MAX) return { ok: false, status: 400, error: 'caption_too_long' };
  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: 'unauthorized' };
  try {
    const allowed = await senderCanShare(createUserSupabaseClient(token), getSupabase(), ref);
    if (!allowed) return { ok: false, status: 403, error: 'share_not_allowed' };
  } catch (err: any) {
    console.warn(`[Chat] shared-content check failed: ${err?.message || err}`);
    return { ok: false, status: 503, error: 'share_check_unavailable' };
  }
  return { ok: true, metadata: { kind: ref.kind, id: ref.id } };
}

/**
 * VTID-05311: GET /shared-preview?kind=&id= — the card of a shared item for
 * the CALLER, resolved with the caller's own permissions (user-scoped client,
 * RLS decides). `{ available:true, title, description, image_url, url }` or
 * `{ available:false, reason:'deleted'|'restricted' }`.
 */
router.get('/shared-preview', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const ref = parseSharedRef({ kind: req.query.kind, id: req.query.id });
  if (!ref) return res.status(400).json({ ok: false, error: 'invalid_shared_content' });
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const preview = await resolveSharedPreview(createUserSupabaseClient(token), getSupabase(), ref);
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.json({ ok: true, ...preview });
  } catch (err: any) {
    console.warn(`[Chat] shared-preview failed: ${err?.message || err}`);
    return res.status(503).json({ ok: false, error: 'preview_unavailable' });
  }
});

// VTID-05309: GET /search — message search across the caller's DMs and groups (routes/chat-search.ts).
router.use('/search', chatSearchRouter);
// VTID-05312: viewing heartbeats (push suppression for the open conversation).
router.use('/viewing', chatViewingRouter);

// VTID-03459/VTID-03470: per-user in-flight guard for POST /vitana-reply
// (see below). Module-level because this route file is a singleton Express
// router — safe within one instance, not distributed.
//
// Maps user_id -> the timestamp the in-flight call started. A plain Set
// with no expiry was tried first and found live-testing to be unsafe: a
// slow handleVitanaTextReply() call (memory-orchestrator retrieval can take
// 30s+ under load) would hold the guard open for its full duration, and a
// naive guard blocks a legitimate retry after a client-side timeout.
// VITANA_REPLY_STALE_MS bounds how long a guard entry is honored before a
// fresh request is allowed through again.
const vitanaReplyInFlight = new Map<string, number>();
const VITANA_REPLY_STALE_MS = 90_000;
// VTID-05310: POST /delivered accepts at most this many ids per call.
const MAX_DELIVERED_IDS = 200;

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE!
  );
}

// ── POST /send — Send a direct message ───────────────────────

router.post('/send', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { receiver_id, content, message_type, content_data, client_message_id, reply_to_message_id } = req.body as {
    receiver_id?: unknown;
    content?: unknown;
    message_type?: unknown;
    content_data?: unknown;
    client_message_id?: unknown;
    reply_to_message_id?: unknown;
  };

  if (!receiver_id || typeof receiver_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'receiver_id is required' });
  }
  if (receiver_id === identity.user_id) {
    return res.status(400).json({ ok: false, error: 'cannot message yourself' });
  }

  const msgType = typeof message_type === 'string' && message_type.length > 0 ? message_type : 'text';
  const allowedTypes = new Set(['text', 'attachment', 'voice', 'voice_transcript', CALENDAR_INVITE_TYPE, SHARED_CONTENT_TYPE]);
  if (!allowedTypes.has(msgType)) {
    return res.status(400).json({ ok: false, error: 'invalid_message_type' });
  }

  const rawContent = typeof content === 'string' ? content : '';
  let trimmedContent = rawContent.trim();
  // VTID-05310: a reply target is never taken from client content_data.
  let metadata: Record<string, unknown> = content_data && typeof content_data === 'object'
    ? repo.stripClientReplyTo(content_data as Record<string, unknown>)
    : {};

  // VTID-05310: a retry of a send that already went through is answered with
  // the stored row before any check that could refuse it (e.g. invite limits).
  if (isUuidParam(client_message_id)) {
    const prior = await repo.findPriorSend(getSupabase(), identity.user_id, client_message_id.toLowerCase(), { kind: 'dm', a: identity.user_id, b: receiver_id });
    if (prior.kind === 'conflict') return res.status(409).json({ ok: false, error: 'client_message_id_conflict' });
    if (prior.kind === 'duplicate') return res.status(200).json({ ok: true, data: withReplyId(prior.row), duplicate: true });
  }

  // VTID-04917: an invite card is built on the server from the sender's own
  // calendar entry; the client sends only { entry_id }.
  if (msgType === CALENDAR_INVITE_TYPE) {
    // VTID-05104: test accounts, tenant, relationship and send limits.
    const allowed = await checkInviteSend({
      sb: getSupabase(),
      senderId: identity.user_id,
      tenantId: identity.tenant_id,
      receiverId: receiver_id,
    });
    if (!allowed.ok) return res.status(INVITE_REFUSED_STATUS).json(inviteRefusedBody());
    const invite = await buildInviteForChat(identity.user_id, content_data);
    if (!invite.ok) {
      return res.status(invite.status).json({ ok: false, error: invite.error, ...(invite.reason ? { reason: invite.reason } : {}) });
    }
    metadata = { ...invite.metadata };
    trimmedContent = invite.content;
  }
  // VTID-05311: a shared post / event / product / profile is stored as
  // { kind, id } (+ the server's reply_to); the sender must be able to see it.
  if (msgType === SHARED_CONTENT_TYPE) {
    const shared = await checkSharedContentSend(req, content_data, trimmedContent);
    if (!shared.ok) return res.status(shared.status).json({ ok: false, error: shared.error });
    metadata = { ...shared.metadata };
  }
  // VTID-05207: a DM tagged metadata.source='new_member_greeting' is a "Say
  // Hello 👋" greeting to a newcomer. It runs a fail-closed guard (block/mute,
  // opt-in + 7-day card window, test/service accounts, one-per-pair, hourly
  // cap) BEFORE the insert and the Lane-D push grouping. The tag only ADDS
  // these restrictions — an untagged DM takes exactly the path it does today.
  if (metadata.source === NEW_MEMBER_GREETING_SOURCE) {
    const allowed = await checkGreetingSend({
      sb: getSupabase(),
      senderId: identity.user_id,
      receiverId: receiver_id,
      tenantId: identity.tenant_id,
    });
    if (!allowed.ok) return res.status(GREETING_REFUSED_STATUS).json(greetingRefusedBody());
  }
  const attachments = Array.isArray((metadata as any).attachments) ? (metadata as any).attachments : [];

  if (msgType === 'text') {
    if (trimmedContent.length === 0) {
      return res.status(400).json({ ok: false, error: 'content is required' });
    }
  } else if (msgType !== SHARED_CONTENT_TYPE && trimmedContent.length === 0 && attachments.length === 0) {
    return res.status(400).json({ ok: false, error: 'content_or_attachment_required' });
  }

  const supabase = getSupabase();

  // VTID-05310: optional client_message_id (idempotent send) and reply target
  // (must be a message of this DM pair). Stored as metadata.reply_to — an id
  // only, never a copy of the parent's content.
  const sendIdentity = client_message_id != null || reply_to_message_id != null
    ? await repo.resolveSendIdentity(
      supabase,
      { client_message_id, reply_to_message_id },
      { kind: 'dm', a: identity.user_id, b: receiver_id },
    )
    : NO_SEND_IDENTITY;
  if (!sendIdentity.ok) return res.status(400).json({ ok: false, error: sendIdentity.error });
  if (sendIdentity.replyTo) metadata = { ...metadata, reply_to: { message_id: sendIdentity.replyTo } };

  // VTID-01967: denormalize sender + receiver vitana_id at insert time so
  // support engineers and voice tooling can quote @<id> without joining
  // profiles. Both lookups are cached. Null-tolerant: if either user has
  // no vitana_id (pre-Release-A signup, or app_users not yet provisioned),
  // the column stays NULL and downstream code falls back to display_name.
  const [sender_vitana_id, receiver_vitana_id] = await Promise.all([
    identity.vitana_id ? Promise.resolve(identity.vitana_id) : resolveVitanaId(identity.user_id),
    resolveVitanaId(receiver_id),
  ]);

  const row = {
    tenant_id: identity.tenant_id,
    sender_id: identity.user_id,
    receiver_id,
    content: trimmedContent,
    message_type: msgType,
    metadata,
    ...(sender_vitana_id && { sender_vitana_id }),
    ...(receiver_vitana_id && { receiver_vitana_id }),
  };
  const { data, error, duplicate, conflict } = sendIdentity.clientMessageId
    ? await repo.insertChatMessageIdempotent(supabase, row, sendIdentity.clientMessageId, repo.insertChatMessage, { kind: 'dm', a: identity.user_id, b: receiver_id })
    : { ...(await repo.insertChatMessage(supabase, row)), duplicate: false };

  if (conflict) return res.status(409).json({ ok: false, error: 'client_message_id_conflict' });
  if (error) {
    console.error('[Chat] Send error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  // VTID-05310: a repeat of an already stored send — same row back, no push.
  if (duplicate) {
    return res.status(200).json({ ok: true, data: withReplyId(data), duplicate: true });
  }

  // VTID-03470: /send no longer triggers the Vitana bot reply itself — it
  // only ever inserts a message, for any receiver, bot or human. Generating
  // the bot's reply used to happen here fire-and-forget, which silently lost
  // replies under GCP Cloud Run's CPU throttling: a background promise is
  // only guaranteed CPU while a request is in flight, and once /send
  // responded, Cloud Run could freeze the promise before it finished writing
  // the reply (confirmed live — the LLM call completed successfully per its
  // own telemetry, but the chat_messages insert never happened). Callers
  // that want a Vitana reply now explicitly call POST /vitana-reply (below)
  // right after a successful send to the bot, and await it — that keeps the
  // request (and therefore the CPU) alive for the reply's full duration,
  // deterministically completing or surfacing an explicit error instead of
  // silently vanishing. See vitana-v1's useGlobalMessages.ts for the caller.
  if (!isVitanaBot(receiver_id)) {
    // BOOTSTRAP-NOTIF-CATEGORIES: Resolve the sender's display name so that the
    // push notification looks like a classic chat notification ("John Doe" as
    // the title, message body as the preview) rather than a generic "New message".
    // We query `app_users` (the profile table used across the platform).
    let senderName = 'New message';
    try {
      const { data: senderProfile } = await repo.fetchSenderProfile(supabase, identity.user_id);
      if (senderProfile) {
        senderName = senderProfile.display_name
          || (senderProfile.email ? senderProfile.email.split('@')[0] : 'New message');
      }
    } catch (err: any) {
      console.warn('[Chat] Failed to resolve sender name, falling back to generic:', err?.message);
    }

    // Fire-and-forget push notification to the receiver (not for Vitana bot)
    // BOOTSTRAP-NOTIF-CATEGORIES: Use /inbox/u/<sender_id> so the Messages
    // page deep-links into the conversation (see the path-based url below).
    // Notification body: prefer text; for attachment-only messages show
    // "📎 <filename>" so the push isn't an empty bubble.
    const firstAttachmentName: string | null = attachments.length > 0
      ? (attachments[0] as any)?.filename || (attachments[0] as any)?.name || null
      : null;
    let notifBody = trimmedContent;
    if (notifBody.length === 0) {
      if (msgType === 'attachment') {
        notifBody = firstAttachmentName ? `📎 ${firstAttachmentName}` : '📎 Attachment';
      } else if (msgType === 'voice' || msgType === 'voice_transcript') {
        notifBody = '🎤 Voice message';
      }
    }

    // BOOTSTRAP-COMMUNITY-MARKETPLACE (Chunk 5): "Message seller"/"Contact
    // provider" CTAs send the first message through this same endpoint with
    // content_data.cta_source='community_marketplace' — swap the generic
    // "<sender name>: <text>" push for listing-specific copy so the seller
    // sees "Someone is interested in <listing>" instead of an anonymous chat
    // preview. Still writes a normal chat_messages row above; only the push
    // notification's type/copy differs.
    const listingTitle = typeof (metadata as any).listing_title === 'string'
      ? (metadata as any).listing_title.slice(0, 120)
      : null;
    const isListingInterest = (metadata as any).cta_source === 'community_marketplace' && !!listingTitle;

    let notifType = 'new_chat_message';
    let notifTitle = senderName;
    let notifBodyFinal = notifBody.length > 100 ? notifBody.slice(0, 97) + '...' : notifBody;
    const notifData: Record<string, string> = {
      type: 'new_chat_message',
      sender_id: identity.user_id,
      sender_name: senderName,
      message_id: data.id,
      thread_id: identity.user_id,
      // Path-based deep-link — query-string form (?recipient=…&context=global)
      // silently fails in Appilix's Android in-app browser when launched from
      // a notification tap (confirmed via BOOTSTRAP-NOTIF-MESSENGER-DIAG:
      // diagnostic beacon never fired, no Cloud Run hit recorded). Path form
      // launches cleanly because the URL has no special characters.
      url: `/inbox/u/${identity.user_id}`,
    };

    if (msgType === CALENDAR_INVITE_TYPE) {
      // VTID-05104: the lock screen gets a generic line, never title/time/place
      // (the card inside the conversation is unchanged).
      const receiverLocale = await getUserLocale(supabase, receiver_id);
      notifBodyFinal = tt('notif.calendar_invite.body', receiverLocale, { name: senderName });
    }
    if (msgType === SHARED_CONTENT_TYPE) {
      // VTID-05311: a generic line, never the shared item's content.
      const receiverLocale = await getUserLocale(supabase, receiver_id);
      notifBodyFinal = tt('notif.chat_shared_content.body', receiverLocale, { name: senderName });
    }

    if (isListingInterest) {
      const receiverLocale = await getUserLocale(supabase, receiver_id);
      notifType = 'listing_interest';
      notifTitle = tt('notif.listing_interest.title', receiverLocale);
      notifBodyFinal = tt('notif.listing_interest.body', receiverLocale, { title: listingTitle! });
      notifData.type = 'listing_interest';
      notifData.listing_title = listingTitle!;
      if (typeof (metadata as any).listing_id === 'string') {
        notifData.listing_id = (metadata as any).listing_id;
      }
    }

    // Awaited (not fire-and-forget) so the HTTP response below isn't sent
    // until the push dispatch has actually finished — Cloud Run only
    // guarantees CPU while a request is in flight, so a fire-and-forget
    // promise here can get frozen/killed the instant res.status(201) flushes
    // (same failure mode confirmed live and fixed for daily-feature-tip, see
    // scheduled-notifications.ts BOOTSTRAP-DAILY-FEATURE-TIP). try/catch so a
    // push failure never turns a successfully-sent chat message into a 500.
    try {
      let payload: NotificationPayload = { title: notifTitle, body: notifBodyFinal, data: notifData };
      let notifyOpts: NotifyUserOptions | undefined;
      let skipNotify = false;
      // VTID-05208: a new-member greeting DM (metadata.source =
      // 'new_member_greeting') is grouped per RECIPIENT over 24 h — one push a
      // day however many members greet the newcomer. null = a test/service
      // account is involved (or the exclusion lookup failed): no notification.
      if (notifType === 'new_chat_message' && msgType === 'text' && isNewMemberGreeting(metadata)) {
        const prepared = await prepareNewMemberGreetingPush(supabase, {
          senderId: identity.user_id,
          receiverId: receiver_id,
          payload,
        });
        if (prepared) {
          payload = prepared.payload;
          notifyOpts = prepared.opts;
        } else {
          skipNotify = true;
          console.warn('[Chat] Greeting DM notification skipped (excluded account or exclusion lookup failed)');
        }
      // VTID-05137: plain chat messages are coalesced per conversation (one
      // push per burst). Calendar invites and listing-interest pushes are
      // events of their own and always go out unchanged.
      } else if (notifType === 'new_chat_message' && msgType !== CALENDAR_INVITE_TYPE && msgType !== SHARED_CONTENT_TYPE) {
        const [prepared] = await coalesceChatPushes(
          supabase,
          chatConversationKey({ senderId: identity.user_id }),
          [{ userId: receiver_id, payload, kind: 'message' }],
        );
        payload = prepared.payload;
        notifyOpts = prepared.opts;
      }
      if (skipNotify) {
        // VTID-05208: nothing to send (see above).
      } else if (notifyOpts) {
        await notifyUser(receiver_id, identity.tenant_id!, notifType, payload, supabase, notifyOpts);
      } else {
        await notifyUser(receiver_id, identity.tenant_id!, notifType, payload, supabase);
      }
    } catch (err: any) {
      console.error('[Chat] Push notification dispatch failed:', err?.message || err);
    }
  }

  return res.status(201).json({ ok: true, data: withReplyId(data) });
});

// VTID-05310 helpers. The repository's new functions are called only when a
// request uses the new fields (or a row carries a reply target), so a request
// without them makes exactly the calls it made before.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Local (not repo.isUuid): tests mock the repository partially.
export function isUuidParam(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
export const NO_SEND_IDENTITY = { ok: true as const, clientMessageId: null as string | null, replyTo: null as string | null };

/** A row the gateway just validated exposes its own reply target. */
export function withReplyId<T extends Record<string, any>>(row: T): T & { reply_to_message_id: string | null } {
  const id = row?.metadata?.reply_to?.message_id;
  return { ...row, reply_to_message_id: isUuidParam(id) ? id : null };
}

/** Read endpoints: reply targets checked against the conversation (I1); no query when no row has one. */
export async function annotateReplies(
  sb: ReturnType<typeof getSupabase>,
  rows: any[] | null | undefined,
  scope: repo.ConversationScope,
): Promise<any[]> {
  const list = rows ?? [];
  if (!list.some((r) => r?.metadata?.reply_to?.message_id)) return list.map((r) => ({ ...r, reply_to_message_id: null }));
  return repo.annotateReplyTargets(sb, list, scope);
}

// ── POST /vitana-reply — Explicitly generate + await a Vitana bot reply ──
// VTID-03470: see the comment in /send above. This is AWAITED end-to-end by
// the caller, so the request (and Cloud Run's CPU allocation for it) stays
// alive for the reply's full duration — completion is deterministic, not a
// race against the platform freezing a background promise. The reply is
// still written to chat_messages exactly as before, so the existing
// Supabase Realtime subscription in the frontend renders it with no other
// client-side change required; the response body is a same-turn convenience,
// not the only way the reply reaches the UI.

router.post('/vitana-reply', requireAuth, requireTenant, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: this handler is a thin HTTP wrapper around
  // handleVitanaTextReply() -> processConversationTurn()/processBrainTurn(),
  // which already emit the real state-transition events for this turn
  // (conversation.turn.received, conversation.model.called,
  // conversation.turn.completed, brain.turn.received/processed) — see
  // conversation-client.ts and vitana-brain.ts. Emitting a second event here
  // would duplicate that telemetry, not add signal.
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!identity.tenant_id) return res.status(400).json({ ok: false, error: 'tenant_required' });

  const { content } = req.body as { content?: unknown };
  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  if (trimmedContent.length === 0) {
    return res.status(400).json({ ok: false, error: 'content is required' });
  }

  // Same per-user in-flight guard used previously on /send (VTID-03459),
  // now protecting this endpoint instead: a client-side double-invocation
  // (e.g. a retry after a slow-but-still-running first call) gets a clear
  // 409 rather than spawning a second concurrent LLM turn for the same user.
  const now = Date.now();
  const inFlightSince = vitanaReplyInFlight.get(identity.user_id);
  if (inFlightSince !== undefined && now - inFlightSince < VITANA_REPLY_STALE_MS) {
    return res.status(409).json({ ok: false, error: 'reply_in_progress' });
  }
  vitanaReplyInFlight.set(identity.user_id, now);

  const supabase = getSupabase();
  try {
    const result = await handleVitanaTextReply(
      identity.user_id,
      identity.tenant_id,
      trimmedContent,
      supabase,
    );
    if (!result.ok) {
      return res.status(502).json({ ok: false, error: result.error || 'vitana_reply_failed' });
    }
    return res.status(200).json({ ok: true, reply: result.reply });
  } finally {
    // Only clear the entry this call itself set — a very-late-finishing call
    // must not clobber a fresher in-flight entry the staleness window let
    // through in the meantime.
    if (vitanaReplyInFlight.get(identity.user_id) === now) {
      vitanaReplyInFlight.delete(identity.user_id);
    }
  }
});

// ── GET /conversation/:peerId — Messages between me and peer ─

router.get('/conversation/:peerId', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { peerId } = req.params;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before as string | undefined; // ISO cursor
  const after = req.query.after as string | undefined; // VTID-05310: ISO cursor, forward paging
  const around = req.query.around as string | undefined; // VTID-05310: message id, context window

  // VTID-05310: peerId is interpolated into the PostgREST or-filter below.
  if (!isUuidParam(peerId)) return res.status(400).json({ ok: false, error: 'invalid_peer_id' });
  if (around !== undefined && !isUuidParam(around)) return res.status(400).json({ ok: false, error: 'invalid_around' });

  const supabase = getSupabase();
  const scope = { kind: 'dm' as const, a: identity.user_id, b: peerId };

  if (around) {
    const win = await repo.fetchWindowAround(
      supabase,
      repo.dmScopeQuery(supabase, identity.tenant_id, identity.user_id, peerId),
      around,
      limit,
    );
    if ('error' in win) {
      console.error('[Chat] Conversation window error:', win.error);
      return res.status(500).json({ ok: false, error: win.error.message });
    }
    if ('notFound' in win) return res.status(404).json({ ok: false, error: 'message_not_found' });
    const rows = await annotateReplies(supabase, win.data, scope);
    return res.json({ ok: true, data: rows, has_older: win.has_older, has_newer: win.has_newer });
  }

  const { data, error } = after
    ? await repo.fetchConversationMessagesAfter(supabase, identity.tenant_id, identity.user_id, peerId, limit, after)
    : await repo.fetchConversationMessages(supabase, identity.tenant_id, identity.user_id, peerId, limit, before);

  if (error) {
    console.error('[Chat] Conversation fetch error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true, data: await annotateReplies(supabase, data, scope) });
});

// ── GET /conversations — List recent conversations ───────────

router.get('/conversations', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();

  // The inbox is a scrollable list of every conversation the user has, not a
  // "recent 50" digest — a 50 cap silently truncated the list for almost every
  // active member (VTID-03493). Callers may narrow it; the ceiling only exists
  // to stop a hand-crafted request asking for unbounded work.
  const limit = Math.min(Number(req.query.limit) || 250, 500);

  // Server-side dedup: use DISTINCT ON to get latest message per peer in one query
  const { data, error } = await repo.getRecentConversationsRpc(supabase, {
    p_user_id: identity.user_id,
    p_tenant_id: identity.tenant_id,
    p_limit: limit,
  });

  if (error) {
    // Fallback to client-side dedup if RPC not available yet
    console.warn('[Chat] RPC get_recent_conversations failed, falling back:', error.message);

    // This limit counts MESSAGES, but the dedup below collapses them to
    // conversations — a chatty peer can eat hundreds of rows on its own. Pull
    // a multiple of the requested conversation count so the fallback doesn't
    // return a far shorter inbox than the RPC path it stands in for.
    const { data: fallbackData, error: fallbackErr } = await repo.fetchConversationsFallback(
      supabase,
      identity.tenant_id,
      identity.user_id,
      Math.min(limit * 8, 2000),
    );

    if (fallbackErr) {
      console.error('[Chat] Conversations list error:', fallbackErr);
      return res.status(500).json({ ok: false, error: fallbackErr.message });
    }

    const seen = new Map<string, typeof fallbackData[0]>();
    for (const msg of fallbackData || []) {
      const peerId = msg.sender_id === identity.user_id ? msg.receiver_id : msg.sender_id;
      if (!seen.has(peerId)) {
        seen.set(peerId, msg);
      }
    }

    const conversations = Array.from(seen.entries()).map(([peerId, lastMessage]) => ({
      peer_id: peerId,
      last_message: lastMessage,
    }));

    return res.json({ ok: true, data: conversations });
  }

  // RPC returns rows with peer_id already computed
  const conversations = (data || []).map((row: any) => ({
    peer_id: row.peer_id,
    last_message: {
      id: row.id,
      tenant_id: row.tenant_id,
      sender_id: row.sender_id,
      receiver_id: row.receiver_id,
      content: row.content,
      read_at: row.read_at,
      created_at: row.created_at,
      message_type: row.message_type || 'text',
      metadata: row.metadata || {},
    },
  }));

  return res.json({ ok: true, data: conversations });
});

// ── POST /read — Mark messages from a peer as read ───────────

router.post('/read', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { peer_id } = req.body;
  if (!peer_id || typeof peer_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'peer_id is required' });
  }

  const supabase = getSupabase();
  // VTID-05310: a read message is also delivered. Best effort (before the
  // migration the column is missing and this is a no-op error).
  try {
    const delivered = await repo.markPeerMessagesDelivered(supabase, identity.tenant_id, peer_id, identity.user_id);
    if (delivered?.error && !repo.isMissingColumn(delivered.error, 'delivered_at')) {
      console.warn('[Chat] Mark delivered (on read) failed:', delivered.error.message);
    }
  } catch (err: any) {
    console.warn('[Chat] Mark delivered (on read) failed:', err?.message || err);
  }
  const { error } = await repo.markPeerMessagesRead(supabase, identity.tenant_id, peer_id, identity.user_id);

  if (error) {
    console.error('[Chat] Mark read error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true });
});

// ── POST /delivered — Mark received DMs as delivered (VTID-05310) ──

router.post('/delivered', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  // impact-allow-no-oasis: a delivery receipt is a routine per-message client
  // acknowledgement like POST /read, not a governed state transition.
  const ids = (req.body as { message_ids?: unknown })?.message_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'message_ids is required' });
  }
  if (ids.length > MAX_DELIVERED_IDS) {
    return res.status(400).json({ ok: false, error: 'too_many_message_ids' });
  }
  if (!ids.every((id) => isUuidParam(id))) {
    return res.status(400).json({ ok: false, error: 'invalid_message_id' });
  }

  const supabase = getSupabase();
  // Only rows the caller RECEIVED (receiver_id = caller) and not yet delivered.
  const { error, count } = await repo.markMessagesDelivered(supabase, identity.tenant_id, identity.user_id, ids as string[]);
  if (error) {
    if (repo.isMissingColumn(error, 'delivered_at')) return res.json({ ok: true, updated: 0 });
    console.error('[Chat] Mark delivered error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
  return res.json({ ok: true, updated: count ?? 0 });
});

// ── POST /read-all — Mark ALL of the caller's unread DMs as read ──

router.post('/read-all', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  // impact-allow-no-oasis: marking chat messages as read is a routine user
  // read-receipt, not a governed state transition — consistent with the sibling
  // POST /read handler, which likewise emits no OASIS event.
  const supabase = getSupabase();
  const { error, count } = await repo.markAllMessagesRead(supabase, identity.tenant_id, identity.user_id);

  if (error) {
    console.error('[Chat] Mark all read error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true, updated: count ?? 0 });
});

// ── GET /unread-count — Total unread messages ────────────────

router.get('/unread-count', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  const { count, error } = await repo.countUnreadMessages(supabase, identity.tenant_id, identity.user_id);

  if (error) {
    console.error('[Chat] Unread count error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true, count: count || 0 });
});

// ── Vitana text reply handler ─────────────────────────────────
// When a user sends a text message to Vitana through the DM interface,
// route it through the unified conversation intelligence layer and
// write Vitana's reply back to chat_messages.

/**
 * VTID-03620: every call into processConversationTurn/processBrainTurn from
 * this handler used to omit BOTH thread_id and conversation_history, so
 * getOrCreateThread() (conversation-client.ts) minted a brand-new random
 * thread on every single message — the model had zero memory of anything
 * said one turn earlier in the SAME visible DM. Reported live: Vitana
 * re-resolving a message recipient from scratch every turn, re-asking for
 * the message body after the user had already supplied it in a prior
 * message, and an incoherent first reply. This reconstructs recent history
 * from chat_messages (already persisted for every DM turn) and a stable
 * per-DM thread id, mirroring how a real multi-turn conversation is meant
 * to work — same fix pattern applied to handleVitanaGroupMention
 * (routes/chat-groups.ts), which had the identical gap.
 */
async function fetchVitanaDmHistory(
  supabase: ReturnType<typeof getSupabase>,
  tenantId: string,
  userId: string,
  currentMessage: string,
  limit = 12,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  try {
    const { data, error } = await repo.fetchVitanaDmHistoryRows(supabase, tenantId, userId, VITANA_BOT_USER_ID, limit + 1);
    if (error || !data) return [];

    const rows = [...data].reverse() as Array<{ sender_id: string; content: string | null }>;
    // The caller's own message for THIS turn is already in chat_messages (the
    // client's prior POST /send call wrote it before hitting /vitana-reply) —
    // drop it here so it is not duplicated between conversation_history and
    // the turn's own `message` field.
    const last = rows[rows.length - 1];
    if (last && last.sender_id === userId && last.content === currentMessage) {
      rows.pop();
    }

    return rows
      .filter((r): r is { sender_id: string; content: string } => !!r.content && r.content.trim().length > 0)
      .slice(-limit)
      .map((r) => ({
        role: r.sender_id === userId ? ('user' as const) : ('assistant' as const),
        content: r.content,
      }));
  } catch {
    // History is an enhancement, never a hard dependency — a fetch failure
    // degrades to the old (context-free) behavior rather than failing the turn.
    return [];
  }
}

async function handleVitanaTextReply(
  userId: string,
  tenantId: string,
  userContent: string,
  supabase: ReturnType<typeof getSupabase>,
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  const startTime = Date.now();

  // VTID-05100: the member texted Vitana — mark their latest companion
  // message as replied (back-off, plan §B). Fire-and-forget: never awaited,
  // never fails or delays the reply.
  markCompanionRepliedInBackground(supabase, userId);

  try {
    // VITANA-BRAIN: Route through brain when flag is enabled, else legacy path
    const { isVitanaBrainEnabled } = await import('../services/system-controls-service');
    const useBrain = await isVitanaBrainEnabled();

    // VTID-03620: stable per-DM thread id + reconstructed recent history —
    // see fetchVitanaDmHistory's header comment for why this is required.
    const threadId = `vitana-dm:${tenantId}:${userId}`;
    const conversationHistory = await fetchVitanaDmHistory(supabase, tenantId, userId, userContent);

    let result: { ok: boolean; reply: string; error?: string; thread_id: string; turn_number: number; meta: { model_used: string; latency_ms: number } };

    if (useBrain) {
      console.log('[Chat] Using Vitana Brain path');
      const { processBrainTurn } = await import('../services/vitana-brain');
      result = await processBrainTurn({
        channel: 'orb',
        tenant_id: tenantId,
        user_id: userId,
        role: 'user',
        message: userContent,
        message_type: 'text',
        thread_id: threadId,
        conversation_history: conversationHistory,
        vtid: 'VTID-CHAT-BRIDGE',
      });
    } else {
      result = await processConversationTurn({
        channel: 'orb',
        tenant_id: tenantId,
        user_id: userId,
        role: 'user',
        message: userContent,
        message_type: 'text',
        thread_id: threadId,
        conversation_history: conversationHistory,
        vtid: 'VTID-CHAT-BRIDGE',
      });
    }

    if (!result.ok || !result.reply) {
      const error = result.error || 'empty reply';
      console.warn(`[Chat] Vitana reply failed: ${error}`);
      return { ok: false, error };
    }

    // VTID-03587: derive the client-actionable instructions BEFORE the insert
    // so a malformed tool call can never cost the user their reply text.
    const dmActions = extractDmActions((result as { tool_calls?: unknown }).tool_calls);
    if (dmActions.length > 0) {
      console.log(
        `[Chat] Vitana reply carries ${dmActions.length} action(s): ${dmActions
          .map((a) => (a.kind === 'navigate' ? `navigate:${a.screen_id ?? a.route}` : `event:${a.event}`))
          .join(', ')}`,
      );
    }

    // Write Vitana's reply to chat_messages
    const { error } = await repo.insertVitanaReplyMessage(supabase, {
      tenant_id: tenantId,
      sender_id: VITANA_BOT_USER_ID,
      receiver_id: userId,
      content: result.reply,
      message_type: 'text',
      metadata: {
        source: useBrain ? 'brain_text_dm' : 'text_dm',
        model_used: result.meta.model_used,
        latency_ms: result.meta.latency_ms,
        thread_id: result.thread_id,
        turn_number: result.turn_number,
        brain_enabled: useBrain,
        // VTID-03587: carry the turn's client-actionable tool calls. This
        // array was previously built by processConversationTurn, logged to
        // OASIS, and then dropped — so the assistant would narrate "let me
        // show you the articles" and never open anything, forever. See
        // services/chat/dm-tool-actions.ts.
        actions: dmActions,
      },
    });

    if (error) {
      console.warn(`[Chat] Vitana reply write failed: ${error.message}`);
      return { ok: false, error: error.message };
    }

    console.log(`[Chat] Vitana text reply written (${Date.now() - startTime}ms)`);
    return { ok: true, reply: result.reply };
  } catch (err: any) {
    console.error(`[Chat] Vitana text reply error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export default router;
