/**
 * Vitana Messaging Skill for OpenClaw
 *
 * Direct user-to-user messaging, conversation threading,
 * read receipts, and unread counters. Integrates with
 * the Vitana bot for AI-assisted conversations.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SendMessageSchema = z.object({
  tenant_id: z.string().uuid(),
  sender_id: z.string().uuid(),
  receiver_id: z.string().uuid(),
  content: z.string().min(1).max(10000),
  metadata: z.record(z.unknown()).optional(),
});

const GetConversationSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  peer_id: z.string().uuid(),
  before: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

const ListConversationsSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  limit: z.number().int().min(1).max(50).default(20),
});

const MarkReadSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  peer_id: z.string().uuid(),
});

const UnreadCountSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE required');
  return createClient(url, key);
}

async function callGateway(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<unknown> {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
  const res = await fetch(`${gatewayUrl}/api/v1/chat${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chat endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Send a direct message to another user.
   */
  async send(input: unknown) {
    const { tenant_id, sender_id, receiver_id, content, metadata } =
      SendMessageSchema.parse(input);

    const data = await callGateway('/send', 'POST', {
      tenant_id,
      sender_id,
      receiver_id,
      content,
      metadata,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'messaging.sent',
      actor: 'openclaw-autopilot',
      details: { sender_id, receiver_id, content_length: content.length },
      created_at: new Date().toISOString(),
    });

    return { success: true, message: data };
  },

  /**
   * Get conversation messages with a specific peer.
   */
  async get_conversation(input: unknown) {
    const { tenant_id, user_id, peer_id, before, limit } =
      GetConversationSchema.parse(input);

    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);
    if (before) params.set('before', before);
    params.set('limit', String(limit));

    const data = await callGateway(`/conversation/${peer_id}?${params.toString()}`, 'GET');
    return { success: true, messages: data };
  },

  /**
   * List recent conversations for a user.
   */
  async list_conversations(input: unknown) {
    const { tenant_id, user_id, limit } = ListConversationsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);
    params.set('limit', String(limit));

    const data = await callGateway(`/conversations?${params.toString()}`, 'GET');
    return { success: true, conversations: data };
  },

  /**
   * Mark all messages from a peer as read.
   */
  async mark_read(input: unknown) {
    const { tenant_id, user_id, peer_id } = MarkReadSchema.parse(input);

    const data = await callGateway('/read', 'POST', {
      tenant_id,
      user_id,
      peer_id,
    });

    return { success: true, result: data };
  },

  /**
   * Get total unread message count for a user.
   */
  async unread_count(input: unknown) {
    const { tenant_id, user_id } = UnreadCountSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);

    const data = await callGateway(`/unread-count?${params.toString()}`, 'GET');
    return { success: true, unread: data };
  },
};

export const SKILL_META = {
  name: 'vitana-messaging',
  description: 'Direct messaging, conversations, read receipts, and unread counters',
  actions: Object.keys(actions),
};
