/**
 * Chat Messages API Routes — User-to-user direct messaging
 *
 * Endpoints:
 *   POST   /send               — Send a message to another user (never triggers a Vitana reply)
 *   POST   /vitana-reply       — Generate + await a Vitana bot reply (VTID-03470)
 *   GET    /conversation/:peer — Get messages between current user and peer (paginated)
 *   GET    /conversations      — List recent conversations (latest message per peer)
 *   POST   /read               — Mark messages from a peer as read
 *   GET    /unread-count       — Total unread message count
 */

import { Router, Request, Response } from 'express';
import {
  requireAuth,
  requireTenant,
  resolveVitanaId,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { createClient } from '@supabase/supabase-js';
import { notifyUser } from '../services/notification-service';
import { VITANA_BOT_USER_ID, isVitanaBot } from '../lib/vitana-bot';
import { processConversationTurn } from '../services/conversation-client';
import { extractDmActions } from '../services/chat/dm-tool-actions';
import { tt } from '../i18n/catalog';
import { getUserLocale } from '../i18n/server-locale';

const router = Router();

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

  const { receiver_id, content, message_type, content_data } = req.body as {
    receiver_id?: unknown;
    content?: unknown;
    message_type?: unknown;
    content_data?: unknown;
  };

  if (!receiver_id || typeof receiver_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'receiver_id is required' });
  }
  if (receiver_id === identity.user_id) {
    return res.status(400).json({ ok: false, error: 'cannot message yourself' });
  }

  const msgType = typeof message_type === 'string' && message_type.length > 0 ? message_type : 'text';
  const allowedTypes = new Set(['text', 'attachment', 'voice', 'voice_transcript']);
  if (!allowedTypes.has(msgType)) {
    return res.status(400).json({ ok: false, error: 'invalid_message_type' });
  }

  const rawContent = typeof content === 'string' ? content : '';
  const trimmedContent = rawContent.trim();
  const metadata = content_data && typeof content_data === 'object' ? (content_data as Record<string, unknown>) : {};
  const attachments = Array.isArray((metadata as any).attachments) ? (metadata as any).attachments : [];

  if (msgType === 'text') {
    if (trimmedContent.length === 0) {
      return res.status(400).json({ ok: false, error: 'content is required' });
    }
  } else if (trimmedContent.length === 0 && attachments.length === 0) {
    return res.status(400).json({ ok: false, error: 'content_or_attachment_required' });
  }

  const supabase = getSupabase();

  // VTID-01967: denormalize sender + receiver vitana_id at insert time so
  // support engineers and voice tooling can quote @<id> without joining
  // profiles. Both lookups are cached. Null-tolerant: if either user has
  // no vitana_id (pre-Release-A signup, or app_users not yet provisioned),
  // the column stays NULL and downstream code falls back to display_name.
  const [sender_vitana_id, receiver_vitana_id] = await Promise.all([
    identity.vitana_id ? Promise.resolve(identity.vitana_id) : resolveVitanaId(identity.user_id),
    resolveVitanaId(receiver_id),
  ]);

  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      tenant_id: identity.tenant_id,
      sender_id: identity.user_id,
      receiver_id,
      content: trimmedContent,
      message_type: msgType,
      metadata,
      ...(sender_vitana_id && { sender_vitana_id }),
      ...(receiver_vitana_id && { receiver_vitana_id }),
    })
    .select()
    .single();

  if (error) {
    console.error('[Chat] Send error:', error);
    return res.status(500).json({ ok: false, error: error.message });
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
      const { data: senderProfile } = await supabase
        .from('app_users')
        .select('display_name, email')
        .eq('user_id', identity.user_id)
        .maybeSingle();
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
      await notifyUser(
        receiver_id,
        identity.tenant_id!,
        notifType,
        { title: notifTitle, body: notifBodyFinal, data: notifData },
        supabase,
      );
    } catch (err: any) {
      console.error('[Chat] Push notification dispatch failed:', err?.message || err);
    }
  }

  return res.status(201).json({ ok: true, data });
});

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

  const supabase = getSupabase();

  let query = supabase
    .from('chat_messages')
    .select('*')
    .eq('tenant_id', identity.tenant_id)
    .or(
      `and(sender_id.eq.${identity.user_id},receiver_id.eq.${peerId}),and(sender_id.eq.${peerId},receiver_id.eq.${identity.user_id})`
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) {
    query = query.lt('created_at', before);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[Chat] Conversation fetch error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true, data });
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
  const { data, error } = await supabase.rpc('get_recent_conversations', {
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
    const { data: fallbackData, error: fallbackErr } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('tenant_id', identity.tenant_id)
      .or(`sender_id.eq.${identity.user_id},receiver_id.eq.${identity.user_id}`)
      // DM rows only — mirrors the RPC. Group messages share this table with
      // receiver_id NULL + group_id set, and would dedup to a peer_id of
      // `undefined`, producing an inbox entry with no peer.
      .not('receiver_id', 'is', null)
      .is('group_id', null)
      .order('created_at', { ascending: false })
      .limit(Math.min(limit * 8, 2000));

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
  const { error } = await supabase
    .from('chat_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('tenant_id', identity.tenant_id)
    .eq('sender_id', peer_id)
    .eq('receiver_id', identity.user_id)
    .is('read_at', null);

  if (error) {
    console.error('[Chat] Mark read error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true });
});

// ── POST /read-all — Mark ALL of the caller's unread DMs as read ──

router.post('/read-all', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  // impact-allow-no-oasis: marking chat messages as read is a routine user
  // read-receipt, not a governed state transition — consistent with the sibling
  // POST /read handler, which likewise emits no OASIS event.
  const supabase = getSupabase();
  const { error, count } = await supabase
    .from('chat_messages')
    .update({ read_at: new Date().toISOString() }, { count: 'exact' })
    .eq('tenant_id', identity.tenant_id)
    .eq('receiver_id', identity.user_id)
    .is('read_at', null);

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
  const { count, error } = await supabase
    .from('chat_messages')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', identity.tenant_id)
    .eq('receiver_id', identity.user_id)
    .is('read_at', null);

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

async function handleVitanaTextReply(
  userId: string,
  tenantId: string,
  userContent: string,
  supabase: ReturnType<typeof getSupabase>,
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  const startTime = Date.now();

  try {
    // VITANA-BRAIN: Route through brain when flag is enabled, else legacy path
    const { isVitanaBrainEnabled } = await import('../services/system-controls-service');
    const useBrain = await isVitanaBrainEnabled();

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
    const { error } = await supabase
      .from('chat_messages')
      .insert({
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
