/**
 * Vitana Notifications Skill for OpenClaw
 *
 * Multi-channel notification delivery: email, push, SMS, and in-app.
 * All notifications are tenant-scoped, role-aware, and audited.
 * Delegates actual delivery to the gateway notification endpoints.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CHANNELS = ['email', 'push', 'sms', 'in_app'] as const;

const SendNotificationSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  channel: z.enum(CHANNELS),
  template: z.string().min(1).max(255),
  subject: z.string().max(255).optional(),
  body: z.string().min(1).max(10000),
  metadata: z.record(z.unknown()).optional(),
});

const BroadcastSchema = z.object({
  tenant_id: z.string().uuid(),
  channel: z.enum(CHANNELS),
  template: z.string().min(1).max(255),
  subject: z.string().max(255).optional(),
  body: z.string().min(1).max(10000),
  role_filter: z.enum(['patient', 'professional', 'staff', 'admin', 'community']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const NotificationStatusSchema = z.object({
  tenant_id: z.string().uuid(),
  notification_id: z.string().uuid(),
});

const ListPendingSchema = z.object({
  tenant_id: z.string().uuid(),
  channel: z.enum(CHANNELS).optional(),
  limit: z.number().int().min(1).max(100).default(50),
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
  const res = await fetch(`${gatewayUrl}/api/v1/notifications${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notification endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Send a notification to a specific user via the chosen channel.
   */
  async send(input: unknown) {
    const { tenant_id, user_id, channel, template, subject, body, metadata } =
      SendNotificationSchema.parse(input);

    const result = await callGateway('/send', 'POST', {
      tenant_id,
      user_id,
      channel,
      template,
      subject,
      body,
      metadata,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: `notification.sent.${channel}`,
      actor: 'openclaw-autopilot',
      details: { user_id, template, channel },
      created_at: new Date().toISOString(),
    });

    return { success: true, notification: result };
  },

  /**
   * Broadcast a notification to all users in a tenant (optionally filtered by role).
   */
  async broadcast(input: unknown) {
    const { tenant_id, channel, template, subject, body, role_filter, metadata } =
      BroadcastSchema.parse(input);

    const result = await callGateway('/broadcast', 'POST', {
      tenant_id,
      channel,
      template,
      subject,
      body,
      role_filter,
      metadata,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'notification.broadcast',
      actor: 'openclaw-autopilot',
      details: { channel, template, role_filter },
      created_at: new Date().toISOString(),
    });

    return { success: true, broadcast: result };
  },

  /**
   * Check delivery status of a notification.
   */
  async check_status(input: unknown) {
    const { tenant_id, notification_id } = NotificationStatusSchema.parse(input);
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('notifications')
      .select('id, channel, status, delivered_at, error')
      .eq('id', notification_id)
      .eq('tenant_id', tenant_id)
      .single();

    if (error) throw new Error(`check_status failed: ${error.message}`);
    return { success: true, notification: data };
  },

  /**
   * List pending/failed notifications for retry (used by heartbeat).
   */
  async list_pending(input: unknown) {
    const { tenant_id, channel, limit } = ListPendingSchema.parse(input);
    const supabase = getSupabase();

    let query = supabase
      .from('notifications')
      .select('id, channel, status, created_at, error')
      .eq('tenant_id', tenant_id)
      .in('status', ['pending', 'failed'])
      .order('created_at', { ascending: true })
      .limit(limit);

    if (channel) {
      query = query.eq('channel', channel);
    }

    const { data, error } = await query;
    if (error) throw new Error(`list_pending failed: ${error.message}`);
    return { success: true, notifications: data, count: data?.length ?? 0 };
  },
};

export const SKILL_META = {
  name: 'vitana-notifications',
  description: 'Multi-channel notification delivery: email, push, SMS, and in-app alerts',
  actions: Object.keys(actions),
};
