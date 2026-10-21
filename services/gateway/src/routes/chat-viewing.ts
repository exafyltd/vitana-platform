/**
 * VTID-05312 (messenger-ux-v2/api-viewing-presence) — "I am looking at this
 * conversation" heartbeats. Mounted by routes/chat.ts at /api/v1/chat/viewing.
 *
 *   POST /  { conversation_key: 'dm:<peerId>' | 'group:<groupId>', device_id, active }
 *     active: true  → upsert (caller, device) with expires_at = now + 45 s
 *     active: false → delete (caller, device) — only that conversation's row when
 *                     a conversation_key is sent (a late false for A can't clear B)
 *
 * The client sends active:true every 20 s while the conversation is open,
 * visible and focused, and active:false on blur / hide / leave. Chat pushes
 * for a conversation with an unexpired row of the recipient are not sent
 * (services/chat-viewing-presence.ts). Rows are tenant-scoped and expire on
 * their own; the caller's expired rows are deleted on every write.
 */
import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { CONVERSATION_KEY_RE, VIEWING_TTL_MS } from '../services/chat-viewing-presence';

const router = Router();
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

router.post('/', requireAuth, requireTenant, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: a presence heartbeat is ephemeral client state (45 s
  // rows), not a governed state transition; CLAUDE.md NEVER 10 forbids marking
  // heartbeats as OASIS events.
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const { conversation_key, device_id, active } = (req.body ?? {}) as { conversation_key?: unknown; device_id?: unknown; active?: unknown };

  if (typeof device_id !== 'string' || !DEVICE_ID_RE.test(device_id)) {
    return res.status(400).json({ ok: false, error: 'invalid_device_id' });
  }
  if (typeof active !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'invalid_active' });
  }
  if (active && (typeof conversation_key !== 'string' || !CONVERSATION_KEY_RE.test(conversation_key))) {
    return res.status(400).json({ ok: false, error: 'invalid_conversation_key' });
  }

  const sb = getSupabase();
  const now = Date.now();
  try {
    // The caller's expired rows go on every write (presence never accumulates).
    await sb.from('chat_viewing_presence').delete().eq('user_id', identity.user_id).lt('expires_at', new Date(now).toISOString());
    if (!active) {
      let del = sb.from('chat_viewing_presence').delete().eq('user_id', identity.user_id).eq('device_id', device_id);
      if (typeof conversation_key === 'string' && CONVERSATION_KEY_RE.test(conversation_key)) {
        del = del.eq('conversation_key', conversation_key.toLowerCase());
      }
      const { error } = await del;
      if (error) throw new Error(error.message);
      return res.json({ ok: true, active: false });
    }
    const { error } = await sb.from('chat_viewing_presence').upsert({
      user_id: identity.user_id,
      tenant_id: identity.tenant_id,
      device_id,
      conversation_key: (conversation_key as string).toLowerCase(),
      expires_at: new Date(now + VIEWING_TTL_MS).toISOString(),
      updated_at: new Date(now).toISOString(),
    }, { onConflict: 'user_id,device_id' });
    if (error) throw new Error(error.message);
    return res.json({ ok: true, active: true, ttl_ms: VIEWING_TTL_MS });
  } catch (err: any) {
    // Before the migration (table missing) or on a read error: the client keeps
    // working; pushes simply are not suppressed.
    console.warn(`[ChatViewing] heartbeat not stored: ${err?.message || err}`);
    return res.status(503).json({ ok: false, error: 'viewing_unavailable' });
  }
});

export default router;
