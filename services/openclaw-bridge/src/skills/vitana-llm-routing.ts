/**
 * Vitana LLM Routing Skill for OpenClaw
 *
 * LLM provider/model configuration, routing policy management,
 * policy auditing, and telemetry querying.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const GetPolicySchema = z.object({
  tenant_id: z.string().uuid(),
});

const UpdatePolicySchema = z.object({
  tenant_id: z.string().uuid(),
  stage: z.enum(['planner', 'worker', 'validator', 'operator', 'memory']),
  provider: z.enum(['anthropic', 'vertex', 'openai']),
  model: z.string().min(1).max(100),
  reason: z.string().min(1).max(500),
});

const ResetPolicySchema = z.object({
  tenant_id: z.string().uuid(),
});

const AuditHistorySchema = z.object({
  tenant_id: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(25),
});

const TelemetryQuerySchema = z.object({
  tenant_id: z.string().uuid(),
  vtid: z.string().max(50).optional(),
  stage: z.enum(['planner', 'worker', 'validator', 'operator', 'memory']).optional(),
  provider: z.enum(['anthropic', 'vertex', 'openai']).optional(),
  model: z.string().max(100).optional(),
  status: z.enum(['success', 'error', 'timeout']).optional(),
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

async function callGateway(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<unknown> {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
  const res = await fetch(`${gatewayUrl}/api/v1/llm${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM routing endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Get the current LLM routing policy and allowlists.
   */
  async get_policy(input: unknown) {
    const { tenant_id } = GetPolicySchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);

    const data = await callGateway(`/routing-policy?${params.toString()}`, 'GET');
    return { success: true, policy: data };
  },

  /**
   * Update the LLM routing policy for a specific stage.
   */
  async update_policy(input: unknown) {
    const { tenant_id, stage, provider, model, reason } = UpdatePolicySchema.parse(input);

    const data = await callGateway('/routing-policy', 'POST', {
      tenant_id,
      stage,
      provider,
      model,
      reason,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'llm.policy_updated',
      actor: 'openclaw-autopilot',
      details: { stage, provider, model, reason },
      created_at: new Date().toISOString(),
    });

    return { success: true, policy: data };
  },

  /**
   * Reset LLM routing policy to recommended defaults.
   */
  async reset_policy(input: unknown) {
    const { tenant_id } = ResetPolicySchema.parse(input);

    const data = await callGateway('/routing-policy/reset', 'POST', {
      tenant_id,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'llm.policy_reset',
      actor: 'openclaw-autopilot',
      details: {},
      created_at: new Date().toISOString(),
    });

    return { success: true, policy: data };
  },

  /**
   * Get LLM routing policy audit history.
   */
  async audit_history(input: unknown) {
    const { tenant_id, limit } = AuditHistorySchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('limit', String(limit));

    const data = await callGateway(`/routing-policy/audit?${params.toString()}`, 'GET');
    return { success: true, audit: data };
  },

  /**
   * Query LLM telemetry events with filters.
   */
  async query_telemetry(input: unknown) {
    const { tenant_id, vtid, stage, provider, model, status, limit } =
      TelemetryQuerySchema.parse(input);

    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    if (vtid) params.set('vtid', vtid);
    if (stage) params.set('stage', stage);
    if (provider) params.set('provider', provider);
    if (model) params.set('model', model);
    if (status) params.set('status', status);
    params.set('limit', String(limit));

    const data = await callGateway(`/telemetry?${params.toString()}`, 'GET');
    return { success: true, telemetry: data };
  },
};

export const SKILL_META = {
  name: 'vitana-llm-routing',
  description: 'LLM routing policy management, provider configuration, auditing, and telemetry',
  actions: Object.keys(actions),
};
