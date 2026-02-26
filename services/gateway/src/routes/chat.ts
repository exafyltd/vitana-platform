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
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { notifyUserAsync } from '../services/notification-service';

const router = Router();

// ── POST /send — Send a direct message ───────────────────────

router.post('/send', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { receiver_id, content } = req.body;

  if (!receiver_id || typeof receiver_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'receiver_id is required' });
  }
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'content is required' });
  }
  if (receiver_id === identity.user_id) {
    return res.status(400).json({ ok: false, error: 'cannot message yourself' });
  }

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'database unavailable' });

  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      tenant_id: identity.tenant_id,
      sender_id: identity.user_id,
      receiver_id,
      content: content.trim(),
    })
    .select()
    .single();

  if (error) {
    console.error('[Chat] Send error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  // Fire-and-forget push notification to the receiver
  notifyUserAsync(
    receiver_id,
    identity.tenant_id!,
    'new_chat_message',
    {
      title: 'New message',
      body: content.trim().length > 100 ? content.trim().slice(0, 97) + '...' : content.trim(),
      data: {
        type: 'new_chat_message',
        sender_id: identity.user_id,
        message_id: data.id,
        url: `/messages/${identity.user_id}`,
      },
    },
    supabase,
  );

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
  if (!supabase) return res.status(503).json({ ok: false, error: 'database unavailable' });

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
  if (!supabase) return res.status(503).json({ ok: false, error: 'database unavailable' });

  // Fetch recent messages involving this user, then deduplicate to latest per peer
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('tenant_id', identity.tenant_id)
    .or(`sender_id.eq.${identity.user_id},receiver_id.eq.${identity.user_id}`)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error('[Chat] Conversations list error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  // Deduplicate: keep the latest message per peer
  const seen = new Map<string, typeof data[0]>();
  for (const msg of data || []) {
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
  if (!supabase) return res.status(503).json({ ok: false, error: 'database unavailable' });

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

// ── GET /unread-count — Total unread messages ────────────────

router.get('/unread-count', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'database unavailable' });

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

export default router;
