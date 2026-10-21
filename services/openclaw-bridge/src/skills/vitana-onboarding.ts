/**
 * Vitana Onboarding Skill for OpenClaw
 *
 * Manages the signup funnel, onboarding invitations,
 * and user provisioning repair for stuck signups.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FunnelDashboardSchema = z.object({
  tenant_id: z.string().uuid(),
  stage: z.enum(['started', 'email_sent', 'verified', 'profile_created', 'onboarded', 'abandoned']).optional(),
  search: z.string().max(255).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

const FunnelStatsSchema = z.object({
  tenant_id: z.string().uuid(),
});

const SendInvitationSchema = z.object({
  tenant_id: z.string().uuid(),
  signup_id: z.string().uuid(),
});

const RepairProvisioningSchema = z.object({
  tenant_id: z.string().uuid(),
  signup_id: z.string().uuid(),
});

const ListInvitationsSchema = z.object({
  tenant_id: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(50),
});

const LogAttemptSchema = z.object({
  tenant_id: z.string().uuid(),
  email: z.string().email(),
  source: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
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
  const res = await fetch(`${gatewayUrl}/api/v1/admin/signups${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Onboarding endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Get the signup funnel dashboard with optional stage/search filters.
   */
  async funnel_dashboard(input: unknown) {
    const { tenant_id, stage, search, limit } = FunnelDashboardSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    if (stage) params.set('stage', stage);
    if (search) params.set('search', search);
    params.set('limit', String(limit));

    const data = await callGateway(`?${params.toString()}`, 'GET');
    return { success: true, funnel: data };
  },

  /**
   * Get aggregate funnel statistics per stage.
   */
  async funnel_stats(input: unknown) {
    const { tenant_id } = FunnelStatsSchema.parse(input);
    const data = await callGateway(`/stats?tenant_id=${tenant_id}`, 'GET');
    return { success: true, stats: data };
  },

  /**
   * Send an onboarding invitation to a signup.
   */
  async send_invitation(input: unknown) {
    const { tenant_id, signup_id } = SendInvitationSchema.parse(input);

    const data = await callGateway(`/${signup_id}/invite`, 'POST', {
      tenant_id,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'onboarding.invitation_sent',
      actor: 'openclaw-autopilot',
      details: { signup_id },
      created_at: new Date().toISOString(),
    });

    return { success: true, invitation: data };
  },

  /**
   * Re-run provisioning for a stuck signup.
   */
  async repair(input: unknown) {
    const { tenant_id, signup_id } = RepairProvisioningSchema.parse(input);

    const data = await callGateway(`/${signup_id}/repair`, 'POST', {
      tenant_id,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'onboarding.repair',
      actor: 'openclaw-autopilot',
      details: { signup_id },
      created_at: new Date().toISOString(),
    });

    return { success: true, result: data };
  },

  /**
   * List sent onboarding invitations.
   */
  async list_invitations(input: unknown) {
    const { tenant_id, limit } = ListInvitationsSchema.parse(input);
    const data = await callGateway(`/invitations?tenant_id=${tenant_id}&limit=${limit}`, 'GET');
    return { success: true, invitations: data };
  },

  /**
   * Log a signup attempt (used by signup forms).
   */
  async log_attempt(input: unknown) {
    const { tenant_id, email, source, metadata } = LogAttemptSchema.parse(input);

    const data = await callGateway('/log-attempt', 'POST', {
      tenant_id,
      email,
      source: source ?? 'openclaw-autopilot',
      metadata,
    });

    return { success: true, attempt: data };
  },
};

export const SKILL_META = {
  name: 'vitana-onboarding',
  description: 'Signup funnel management, onboarding invitations, and provisioning repair',
  actions: Object.keys(actions),
};
