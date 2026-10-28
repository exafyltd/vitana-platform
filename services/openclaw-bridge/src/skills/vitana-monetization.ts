/**
 * Vitana Monetization Skill for OpenClaw
 *
 * Creator monetization via Stripe Connect Express,
 * live room revenue split, financial signals,
 * and monetization context for the ORB system.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const MonetizationContextSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

const RecordSignalSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  signal_type: z.enum(['income', 'debt', 'expense', 'savings', 'value_perception', 'trust', 'engagement']),
  value: z.number(),
  metadata: z.record(z.unknown()).optional(),
});

const RecordAttemptSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  monetization_type: z.enum(['upsell', 'premium', 'marketplace', 'tip']),
  outcome: z.enum(['accepted', 'declined', 'deferred', 'ignored']),
  metadata: z.record(z.unknown()).optional(),
});

const AttemptHistorySchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(25),
});

const DetectSignalsSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  message: z.string().min(1).max(10000),
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
  const res = await fetch(`${gatewayUrl}/api/v1/financial-monetization${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Monetization endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Compute monetization context for a user.
   */
  async get_context(input: unknown) {
    const { tenant_id, user_id } = MonetizationContextSchema.parse(input);

    const data = await callGateway('/context', 'POST', {
      tenant_id,
      user_id,
    });

    return { success: true, context: data };
  },

  /**
   * Get the current monetization envelope for a user.
   */
  async get_envelope(input: unknown) {
    const { tenant_id, user_id } = MonetizationContextSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);

    const data = await callGateway(`/envelope?${params.toString()}`, 'GET');
    return { success: true, envelope: data };
  },

  /**
   * Record a financial or value signal.
   */
  async record_signal(input: unknown) {
    const { tenant_id, user_id, signal_type, value, metadata } =
      RecordSignalSchema.parse(input);

    const data = await callGateway('/signal', 'POST', {
      tenant_id,
      user_id,
      signal_type,
      value,
      metadata,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'monetization.signal_recorded',
      actor: 'openclaw-autopilot',
      details: { user_id, signal_type, value },
      created_at: new Date().toISOString(),
    });

    return { success: true, signal: data };
  },

  /**
   * Record a monetization attempt outcome.
   */
  async record_attempt(input: unknown) {
    const { tenant_id, user_id, monetization_type, outcome, metadata } =
      RecordAttemptSchema.parse(input);

    const data = await callGateway('/attempt', 'POST', {
      tenant_id,
      user_id,
      monetization_type,
      outcome,
      metadata,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'monetization.attempt_recorded',
      actor: 'openclaw-autopilot',
      details: { user_id, monetization_type, outcome },
      created_at: new Date().toISOString(),
    });

    return { success: true, attempt: data };
  },

  /**
   * Get monetization attempt history for a user.
   */
  async get_history(input: unknown) {
    const { tenant_id, user_id, limit } = AttemptHistorySchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);
    params.set('limit', String(limit));

    const data = await callGateway(`/history?${params.toString()}`, 'GET');
    return { success: true, history: data };
  },

  /**
   * Detect financial/value signals from a user message.
   */
  async detect_signals(input: unknown) {
    const { tenant_id, user_id, message } = DetectSignalsSchema.parse(input);

    const data = await callGateway('/detect', 'POST', {
      tenant_id,
      user_id,
      message,
    });

    return { success: true, signals: data };
  },

  /**
   * Get ORB-formatted monetization context for system prompt injection.
   */
  async get_orb_context(input: unknown) {
    const { tenant_id, user_id } = MonetizationContextSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);

    const data = await callGateway(`/orb-context?${params.toString()}`, 'GET');
    return { success: true, orb_context: data };
  },
};

export const SKILL_META = {
  name: 'vitana-monetization',
  description: 'Creator monetization, financial signals, monetization context, and ORB integration',
  actions: Object.keys(actions),
};
