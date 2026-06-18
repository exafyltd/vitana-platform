/**
 * Chat Messages API Routes — User-to-user direct messaging
 *
 * Endpoints:
 *   POST   /send               — Send a message to another user
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
import { notifyUserAsync } from '../services/notification-service';
import { VITANA_BOT_USER_ID, isVitanaBot } from '../lib/vitana-bot';
import { processConversationTurn } from '../services/conversation-client';

const router = Router();

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

  // VTID-CHAT-BRIDGE: If receiver is Vitana, generate a reply via the unified
  // conversation intelligence layer and write it back to chat_messages.
  // Skip the bot reply when the message is just an attachment with no text —
  // there's no prompt to reply to.
  if (isVitanaBot(receiver_id) && trimmedContent.length > 0) {
    handleVitanaTextReply(
      identity.user_id,
      identity.tenant_id!,
      trimmedContent,
      supabase,
    ).catch(err => console.warn('[Chat] Vitana text reply failed:', err.message));
  } else if (!isVitanaBot(receiver_id)) {
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
    // BOOTSTRAP-NOTIF-CATEGORIES: Use /inbox?thread=<sender_id> so the Messages
    // page deep-links into the conversation. The legacy `/messages/<id>` URL
    // was redirected to `/inbox` by App.tsx, stripping the thread parameter.
    // `&context=global` ensures the Messages page selects the global chat
    // context on mount so the thread auto-opens regardless of the recipient's
    // current context preference (otherwise a `tenant`-context user lands on
    // /inbox without the thread being selected).
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

    notifyUserAsync(
      receiver_id,
      identity.tenant_id!,
      'new_chat_message',
      {
        title: senderName,
        body: notifBody.length > 100 ? notifBody.slice(0, 97) + '...' : notifBody,
        data: {
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
        },
      },
      supabase,
    );
  }

  return res.status(201).json({ ok: true, data });
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

  // Server-side dedup: use DISTINCT ON to get latest message per peer in one query
  const { data, error } = await supabase.rpc('get_recent_conversations', {
    p_user_id: identity.user_id,
    p_tenant_id: identity.tenant_id,
    p_limit: 50,
  });

  if (error) {
    // Fallback to client-side dedup if RPC not available yet
    console.warn('[Chat] RPC get_recent_conversations failed, falling back:', error.message);

    const { data: fallbackData, error: fallbackErr } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('tenant_id', identity.tenant_id)
      .or(`sender_id.eq.${identity.user_id},receiver_id.eq.${identity.user_id}`)
      .order('created_at', { ascending: false })
      .limit(200);

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
): Promise<void> {
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
      console.warn(`[Chat] Vitana reply failed: ${result.error || 'empty reply'}`);
      return;
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
        },
      });

    if (error) {
      console.warn(`[Chat] Vitana reply write failed: ${error.message}`);
    } else {
      console.log(`[Chat] Vitana text reply written (${Date.now() - startTime}ms)`);
    }
  } catch (err: any) {
    console.error(`[Chat] Vitana text reply error: ${err.message}`);
  }
}

export default router;
