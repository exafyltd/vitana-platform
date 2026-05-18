/**
 * Group Chat API Routes — VTID-03089
 *
 * Endpoints (mounted at /api/v1/chat/groups):
 *   GET    /                       — List groups the caller belongs to
 *   GET    /:id                    — Group info + member list
 *   GET    /:id/messages           — Paginated group message history
 *   POST   /:id/send               — Send a message to the group;
 *                                    @vitana mentions trigger Vitana reply
 *   POST   /:id/read               — Mark all group messages read up to "now"
 */

import { Router, Request, Response } from 'express';
import {
  requireAuth,
  requireTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { notifyUserAsync } from '../services/notification-service';
import { VITANA_BOT_USER_ID, isVitanaBot } from '../lib/vitana-bot';
import { processConversationTurn } from '../services/conversation-client';

const router = Router();

function getSupabase(): SupabaseClient {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE!,
  );
}

const VITANA_MENTION_RE = /(^|\s)@vitana\b/i;

// ── GET / — Groups the caller belongs to ──────────────────────

router.get('/', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();
  const { data: memberships, error } = await supabase
    .from('chat_group_members')
    .select('group_id, last_read_at, role, joined_at')
    .eq('user_id', identity.user_id)
    .eq('tenant_id', identity.tenant_id);

  if (error) {
    console.error('[ChatGroups] List memberships error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  if (!memberships || memberships.length === 0) {
    return res.json({ ok: true, data: [] });
  }

  const groupIds = memberships.map(m => m.group_id);

  const { data: groups, error: groupsErr } = await supabase
    .from('chat_groups')
    .select('id, name, description, is_system, metadata, created_at')
    .in('id', groupIds);

  if (groupsErr) {
    console.error('[ChatGroups] Fetch groups error:', groupsErr);
    return res.status(500).json({ ok: false, error: groupsErr.message });
  }

  const { data: lastMessages, error: lastErr } = await supabase
    .from('chat_messages')
    .select('id, group_id, sender_id, content, created_at, message_type, metadata')
    .in('group_id', groupIds)
    .order('created_at', { ascending: false })
    .limit(500);

  if (lastErr) {
    console.warn('[ChatGroups] Fetch last messages failed:', lastErr.message);
  }

  const lastByGroup = new Map<string, any>();
  for (const msg of lastMessages || []) {
    if (!lastByGroup.has(msg.group_id)) {
      lastByGroup.set(msg.group_id, msg);
    }
  }

  const membershipByGroup = new Map(memberships.map(m => [m.group_id, m]));

  const unreadCounts = await Promise.all(groupIds.map(async gid => {
    const m = membershipByGroup.get(gid);
    const since = m?.last_read_at;
    let q = supabase
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', gid)
      .neq('sender_id', identity.user_id);
    if (since) q = q.gt('created_at', since);
    const { count } = await q;
    return { group_id: gid, count: count || 0 };
  }));
  const unreadByGroup = new Map(unreadCounts.map(u => [u.group_id, u.count]));

  const data = (groups || []).map(g => ({
    id: g.id,
    name: g.name,
    description: g.description,
    is_system: g.is_system,
    metadata: g.metadata,
    created_at: g.created_at,
    role: membershipByGroup.get(g.id)?.role || 'member',
    joined_at: membershipByGroup.get(g.id)?.joined_at,
    last_read_at: membershipByGroup.get(g.id)?.last_read_at,
    last_message: lastByGroup.get(g.id) || null,
    unread_count: unreadByGroup.get(g.id) || 0,
  }));

  data.sort((a, b) => {
    const ta = a.last_message?.created_at || a.created_at;
    const tb = b.last_message?.created_at || b.created_at;
    return tb.localeCompare(ta);
  });

  return res.json({ ok: true, data });
});

// ── GET /:id — Group info + members ───────────────────────────

router.get('/:id', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { id: groupId } = req.params;
  const supabase = getSupabase();

  const membership = await requireMembership(supabase, groupId, identity.user_id);
  if (!membership) {
    return res.status(403).json({ ok: false, error: 'not_a_member' });
  }

  const [{ data: group, error: groupErr }, { data: members, error: membersErr }] = await Promise.all([
    supabase.from('chat_groups').select('*').eq('id', groupId).maybeSingle(),
    supabase.from('chat_group_members').select('user_id, role, joined_at').eq('group_id', groupId),
  ]);

  if (groupErr || !group) {
    return res.status(404).json({ ok: false, error: 'group_not_found' });
  }
  if (membersErr) {
    console.error('[ChatGroups] Members fetch error:', membersErr);
    return res.status(500).json({ ok: false, error: membersErr.message });
  }

  const memberIds = (members || []).map(m => m.user_id);
  let profiles: Array<{ user_id: string; display_name: string | null; avatar_url: string | null }> = [];
  if (memberIds.length > 0) {
    const { data: profileRows } = await supabase
      .from('app_users')
      .select('user_id, display_name, avatar_url')
      .in('user_id', memberIds);
    profiles = profileRows || [];
  }
  const profileById = new Map(profiles.map(p => [p.user_id, p]));

  const enrichedMembers = (members || []).map(m => ({
    user_id: m.user_id,
    role: m.role,
    joined_at: m.joined_at,
    display_name: profileById.get(m.user_id)?.display_name || null,
    avatar_url: profileById.get(m.user_id)?.avatar_url || null,
    is_bot: isVitanaBot(m.user_id),
  }));

  return res.json({
    ok: true,
    data: {
      ...group,
      member_count: enrichedMembers.length,
      members: enrichedMembers,
    },
  });
});

// ── GET /:id/messages — Paginated history ─────────────────────

router.get('/:id/messages', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { id: groupId } = req.params;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before as string | undefined;

  const supabase = getSupabase();

  const membership = await requireMembership(supabase, groupId, identity.user_id);
  if (!membership) {
    return res.status(403).json({ ok: false, error: 'not_a_member' });
  }

  let query = supabase
    .from('chat_messages')
    .select('*')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) {
    console.error('[ChatGroups] Messages fetch error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true, data });
});

// ── POST /:id/send — Send group message ───────────────────────

router.post('/:id/send', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { id: groupId } = req.params;
  const { content } = req.body;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'content is required' });
  }

  const supabase = getSupabase();

  const membership = await requireMembership(supabase, groupId, identity.user_id);
  if (!membership) {
    return res.status(403).json({ ok: false, error: 'not_a_member' });
  }

  const trimmed = content.trim();
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      tenant_id: identity.tenant_id,
      sender_id: identity.user_id,
      receiver_id: null,
      group_id: groupId,
      content: trimmed,
      message_type: 'text',
    })
    .select()
    .single();

  if (error) {
    console.error('[ChatGroups] Send error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  fanoutGroupNotifications(
    supabase,
    groupId,
    identity.user_id,
    identity.tenant_id!,
    trimmed,
    data.id,
  ).catch(err => console.warn('[ChatGroups] Fanout failed:', err.message));

  if (VITANA_MENTION_RE.test(trimmed) && !isVitanaBot(identity.user_id)) {
    handleVitanaGroupMention(
      supabase,
      groupId,
      identity.user_id,
      identity.tenant_id!,
      trimmed,
    ).catch(err => console.warn('[ChatGroups] @vitana reply failed:', err.message));
  }

  return res.status(201).json({ ok: true, data });
});

// ── POST /:id/read — Mark group read up to now ────────────────

router.post('/:id/read', requireAuth, requireTenant, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { id: groupId } = req.params;
  const supabase = getSupabase();

  const membership = await requireMembership(supabase, groupId, identity.user_id);
  if (!membership) {
    return res.status(403).json({ ok: false, error: 'not_a_member' });
  }

  const { error } = await supabase
    .from('chat_group_members')
    .update({ last_read_at: new Date().toISOString() })
    .eq('group_id', groupId)
    .eq('user_id', identity.user_id);

  if (error) {
    console.error('[ChatGroups] Mark read error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.json({ ok: true });
});

// ── helpers ───────────────────────────────────────────────────

async function requireMembership(
  supabase: SupabaseClient,
  groupId: string,
  userId: string,
): Promise<{ role: string } | null> {
  const { data, error } = await supabase
    .from('chat_group_members')
    .select('role')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return { role: (data as any).role };
}

async function fanoutGroupNotifications(
  supabase: SupabaseClient,
  groupId: string,
  senderId: string,
  tenantId: string,
  content: string,
  messageId: string,
): Promise<void> {
  const [{ data: group }, { data: members }, { data: senderProfile }] = await Promise.all([
    supabase.from('chat_groups').select('name').eq('id', groupId).maybeSingle(),
    supabase.from('chat_group_members').select('user_id').eq('group_id', groupId),
    supabase.from('app_users').select('display_name, email').eq('user_id', senderId).maybeSingle(),
  ]);

  const groupName = (group as any)?.name || 'Group chat';
  const senderName = (senderProfile as any)?.display_name
    || ((senderProfile as any)?.email ? (senderProfile as any).email.split('@')[0] : 'Someone');

  const body = content.length > 100 ? content.slice(0, 97) + '...' : content;

  for (const m of (members || []) as Array<{ user_id: string }>) {
    if (m.user_id === senderId) continue;
    if (isVitanaBot(m.user_id)) continue;
    notifyUserAsync(
      m.user_id,
      tenantId,
      'new_chat_message',
      {
        title: groupName,
        body: `${senderName}: ${body}`,
        data: {
          type: 'new_group_message',
          group_id: groupId,
          sender_id: senderId,
          sender_name: senderName,
          message_id: messageId,
          url: `/inbox/g/${groupId}`,
        },
      },
      supabase,
    );
  }
}

async function handleVitanaGroupMention(
  supabase: SupabaseClient,
  groupId: string,
  askerUserId: string,
  tenantId: string,
  content: string,
): Promise<void> {
  const startTime = Date.now();
  const question = content.replace(VITANA_MENTION_RE, ' ').trim() || content;

  try {
    const { isVitanaBrainEnabled } = await import('../services/system-controls-service');
    const useBrain = await isVitanaBrainEnabled();

    let result: { ok: boolean; reply: string; error?: string; thread_id: string; turn_number: number; meta: { model_used: string; latency_ms: number } };

    if (useBrain) {
      const { processBrainTurn } = await import('../services/vitana-brain');
      result = await processBrainTurn({
        channel: 'orb',
        tenant_id: tenantId,
        user_id: askerUserId,
        role: 'user',
        message: question,
        message_type: 'text',
        vtid: 'VTID-03089',
      });
    } else {
      result = await processConversationTurn({
        channel: 'orb',
        tenant_id: tenantId,
        user_id: askerUserId,
        role: 'user',
        message: question,
        message_type: 'text',
        vtid: 'VTID-03089',
      });
    }

    if (!result.ok || !result.reply) {
      console.warn(`[ChatGroups] @vitana reply failed: ${result.error || 'empty reply'}`);
      return;
    }

    const { error } = await supabase
      .from('chat_messages')
      .insert({
        tenant_id: tenantId,
        sender_id: VITANA_BOT_USER_ID,
        receiver_id: null,
        group_id: groupId,
        content: result.reply,
        message_type: 'text',
        metadata: {
          source: useBrain ? 'brain_group_mention' : 'group_mention',
          model_used: result.meta.model_used,
          latency_ms: result.meta.latency_ms,
          thread_id: result.thread_id,
          turn_number: result.turn_number,
          brain_enabled: useBrain,
          asked_by: askerUserId,
        },
      });

    if (error) {
      console.warn(`[ChatGroups] Vitana group reply write failed: ${error.message}`);
    } else {
      console.log(`[ChatGroups] @vitana reply written for group ${groupId} (${Date.now() - startTime}ms)`);
    }
  } catch (err: any) {
    console.error(`[ChatGroups] @vitana handler error: ${err.message}`);
  }
}

export default router;
