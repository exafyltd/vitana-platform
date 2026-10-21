/**
 * Vitana Admin Operations Skill for OpenClaw
 *
 * Admin notification composition, governance rule management,
 * system controls, and compliance enforcement.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ComposeNotificationSchema = z.object({
  tenant_id: z.string().uuid(),
  channel: z.enum(['email', 'push', 'sms', 'in_app']),
  subject: z.string().max(255).optional(),
  body: z.string().min(1).max(10000),
  recipient_ids: z.array(z.string().uuid()).optional(),
  recipient_role: z.enum(['patient', 'professional', 'staff', 'admin', 'community']).optional(),
  send_to_all: z.boolean().optional(),
});

const SentNotificationsSchema = z.object({
  tenant_id: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(50),
});

const GovernanceEvaluateSchema = z.object({
  tenant_id: z.string().uuid(),
  action: z.string().min(1).max(255),
  context: z.record(z.unknown()),
});

const ListGovernanceRulesSchema = z.object({
  tenant_id: z.string().uuid(),
  category: z.string().max(100).optional(),
});

const GovernanceProposalSchema = z.object({
  tenant_id: z.string().uuid(),
  title: z.string().min(1).max(255),
  description: z.string().min(1).max(5000),
  rule_code: z.string().max(50).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ListViolationsSchema = z.object({
  tenant_id: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(25),
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

async function callGateway(path: string, method: 'GET' | 'POST' | 'PATCH', body?: Record<string, unknown>): Promise<unknown> {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
  const res = await fetch(`${gatewayUrl}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Admin ops endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Compose and send an admin notification to users, roles, or all.
   */
  async compose_notification(input: unknown) {
    const { tenant_id, channel, subject, body, recipient_ids, recipient_role, send_to_all } =
      ComposeNotificationSchema.parse(input);

    const data = await callGateway('/admin/notifications/compose', 'POST', {
      tenant_id,
      channel,
      subject,
      body,
      recipient_ids,
      recipient_role,
      send_to_all,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'admin.notification_composed',
      actor: 'openclaw-autopilot',
      details: { channel, recipient_role, send_to_all, recipient_count: recipient_ids?.length },
      created_at: new Date().toISOString(),
    });

    return { success: true, notification: data };
  },

  /**
   * List admin-sent notifications.
   */
  async list_sent_notifications(input: unknown) {
    const { tenant_id, limit } = SentNotificationsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('limit', String(limit));

    const data = await callGateway(`/admin/notifications/sent?${params.toString()}`, 'GET');
    return { success: true, notifications: data };
  },

  /**
   * Evaluate a governance rule for a specific action.
   */
  async evaluate_governance(input: unknown) {
    const { tenant_id, action, context } = GovernanceEvaluateSchema.parse(input);

    const data = await callGateway('/governance/evaluate', 'POST', {
      tenant_id,
      action,
      context,
    });

    return { success: true, evaluation: data };
  },

  /**
   * List governance rules with optional category filter.
   */
  async list_governance_rules(input: unknown) {
    const { tenant_id, category } = ListGovernanceRulesSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    if (category) params.set('category', category);

    const data = await callGateway(`/governance/rules?${params.toString()}`, 'GET');
    return { success: true, rules: data };
  },

  /**
   * Create a governance proposal.
   */
  async create_proposal(input: unknown) {
    const { tenant_id, title, description, rule_code, metadata } =
      GovernanceProposalSchema.parse(input);

    const data = await callGateway('/governance/proposals', 'POST', {
      tenant_id,
      title,
      description,
      rule_code,
      metadata,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'admin.governance_proposal_created',
      actor: 'openclaw-autopilot',
      details: { title, rule_code },
      created_at: new Date().toISOString(),
    });

    return { success: true, proposal: data };
  },

  /**
   * List governance violations.
   */
  async list_violations(input: unknown) {
    const { tenant_id, limit } = ListViolationsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('limit', String(limit));

    const data = await callGateway(`/governance/violations?${params.toString()}`, 'GET');
    return { success: true, violations: data };
  },

  /**
   * Get the governance feed (recent activity).
   */
  async governance_feed(input: unknown) {
    const { tenant_id, limit } = SentNotificationsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('limit', String(limit));

    const data = await callGateway(`/governance/feed?${params.toString()}`, 'GET');
    return { success: true, feed: data };
  },
};

export const SKILL_META = {
  name: 'vitana-admin-ops',
  description: 'Admin notifications, governance rules, proposals, violations, and system controls',
  actions: Object.keys(actions),
};
