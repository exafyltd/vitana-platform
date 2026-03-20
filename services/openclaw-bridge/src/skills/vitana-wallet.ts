/**
 * Vitana Wallet Skill for OpenClaw
 *
 * Manages the user financial wallet (credit/debit operations),
 * referral tracking, and sharing link generation.
 * Distinct from VTN token wallet — this handles fiat/credit operations.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const WalletBalanceSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

const WalletTransactionsSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(25),
});

const GenerateSharingLinkSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  campaign: z.string().max(100).optional(),
  medium: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ListSharingLinksSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

const ListReferralsSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
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
  const res = await fetch(`${gatewayUrl}/api/v1/automations${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wallet endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Get wallet balance for a user.
   */
  async get_balance(input: unknown) {
    const { tenant_id, user_id } = WalletBalanceSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);

    const data = await callGateway(`/wallet/balance?${params.toString()}`, 'GET');
    return { success: true, balance: data };
  },

  /**
   * Get wallet transaction history.
   */
  async get_transactions(input: unknown) {
    const { tenant_id, user_id, limit } = WalletTransactionsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);
    params.set('limit', String(limit));

    const data = await callGateway(`/wallet/transactions?${params.toString()}`, 'GET');
    return { success: true, transactions: data };
  },

  /**
   * Generate a sharing link with UTM parameters.
   */
  async generate_sharing_link(input: unknown) {
    const { tenant_id, user_id, campaign, medium, metadata } =
      GenerateSharingLinkSchema.parse(input);

    const data = await callGateway('/sharing/generate-link', 'POST', {
      tenant_id,
      user_id,
      campaign,
      medium,
      metadata,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'wallet.sharing_link_generated',
      actor: 'openclaw-autopilot',
      details: { user_id, campaign, medium },
      created_at: new Date().toISOString(),
    });

    return { success: true, link: data };
  },

  /**
   * List sharing links for a user.
   */
  async list_sharing_links(input: unknown) {
    const { tenant_id, user_id } = ListSharingLinksSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);

    const data = await callGateway(`/sharing/links?${params.toString()}`, 'GET');
    return { success: true, links: data };
  },

  /**
   * Get referral chain for a user.
   */
  async get_referrals(input: unknown) {
    const { tenant_id, user_id, limit } = ListReferralsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    params.set('user_id', user_id);
    params.set('limit', String(limit));

    const data = await callGateway(`/referrals?${params.toString()}`, 'GET');
    return { success: true, referrals: data };
  },
};

export const SKILL_META = {
  name: 'vitana-wallet',
  description: 'Financial wallet operations, sharing links, and referral tracking',
  actions: Object.keys(actions),
};
