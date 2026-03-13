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
import { createClient } from '@supabase/supabase-js';
import { notifyUserAsync } from '../services/notification-service';

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

export default router;
