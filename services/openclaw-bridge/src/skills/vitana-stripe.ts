/**
 * Vitana Stripe Skill for OpenClaw
 *
 * Manages subscriptions and payment operations through the Vitana
 * Stripe integration. All operations are tenant-scoped and audited.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CreateSubscriptionSchema = z.object({
  tenant_id: z.string().uuid(),
  plan: z.enum(['pro', 'enterprise']),
  payment_method_id: z.string().optional(),
});

const RetryPaymentSchema = z.object({
  tenant_id: z.string().uuid(),
  subscription_id: z.string().min(1),
});

const CheckFailuresSchema = z.object({
  tenant_id: z.string().uuid().optional(),
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

/**
 * Call the gateway's Stripe Connect endpoint (internal).
 * Keeps Stripe API key on the gateway side only.
 */
async function callStripeEndpoint(
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<unknown> {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
  const res = await fetch(`${gatewayUrl}/api/v1/stripe-connect${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe endpoint ${path} failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Create a subscription for a tenant. Delegates to the gateway's
   * Stripe Connect routes (which hold the Stripe secret key).
   */
  async create_subscription(input: unknown) {
    const { tenant_id, plan, payment_method_id } = CreateSubscriptionSchema.parse(input);

    const result = await callStripeEndpoint('/subscriptions', 'POST', {
      tenant_id,
      plan,
      payment_method_id,
    });

    // Audit
    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'stripe.subscription_created',
      actor: 'openclaw-autopilot',
      details: { plan },
      created_at: new Date().toISOString(),
    });

    return { success: true, subscription: result };
  },

  /**
   * Retry a failed payment for a tenant's subscription.
   */
  async retry_payment(input: unknown) {
    const { tenant_id, subscription_id } = RetryPaymentSchema.parse(input);

    const result = await callStripeEndpoint(`/subscriptions/${subscription_id}/retry`, 'POST', {
      tenant_id,
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'stripe.payment_retried',
      actor: 'openclaw-autopilot',
      details: { subscription_id },
      created_at: new Date().toISOString(),
    });

    return { success: true, result };
  },

  /**
   * Check for failed payments across tenants (or for a specific tenant).
   * Used by the heartbeat loop for proactive retry.
   */
  async check_payment_failures(input: unknown) {
    const { tenant_id } = CheckFailuresSchema.parse(input);
    const supabase = getSupabase();

    let query = supabase
      .from('stripe_subscriptions')
      .select('id, tenant_id, status, last_payment_error')
      .in('status', ['past_due', 'unpaid']);

    if (tenant_id) {
      query = query.eq('tenant_id', tenant_id);
    }

    const { data, error } = await query.limit(50);
    if (error) throw new Error(`check_payment_failures failed: ${error.message}`);

    return { success: true, failures: data, count: data?.length ?? 0 };
  },
};

export const SKILL_META = {
  name: 'vitana-stripe',
  description: 'Subscription management and payment operations via Stripe',
  actions: Object.keys(actions),
};
