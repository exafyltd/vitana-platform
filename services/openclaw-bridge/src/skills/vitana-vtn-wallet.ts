/**
 * Vitana VTN Wallet Skill for OpenClaw
 *
 * Manages VTN token balances, transfers, reward distribution,
 * and transaction history. All operations are tenant-scoped
 * with spending limits enforced per role.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const BalanceSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

const TransferSchema = z.object({
  tenant_id: z.string().uuid(),
  from_user_id: z.string().uuid(),
  to_user_id: z.string().uuid(),
  amount: z.number().positive().max(1000000),
  reason: z.string().min(1).max(500),
  idempotency_key: z.string().uuid().optional(),
});

const RewardSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  amount: z.number().positive().max(100000),
  reason: z.enum([
    'referral',
    'content_creation',
    'community_contribution',
    'health_goal_achieved',
    'session_completed',
    'streak_bonus',
    'admin_grant',
  ]),
  metadata: z.record(z.unknown()).optional(),
});

const TransactionHistorySchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(25),
  type: z.enum(['transfer', 'reward', 'purchase', 'refund']).optional(),
});

const SpendSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  amount: z.number().positive(),
  item: z.string().min(1).max(255),
  item_type: z.enum(['service', 'subscription', 'marketplace', 'tip']),
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

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Get VTN balance for a user.
   */
  async get_balance(input: unknown) {
    const { tenant_id, user_id } = BalanceSchema.parse(input);
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('vtn_wallets')
      .select('balance, last_transaction_at, frozen')
      .eq('tenant_id', tenant_id)
      .eq('user_id', user_id)
      .single();

    if (error) throw new Error(`get_balance failed: ${error.message}`);

    return {
      success: true,
      user_id,
      balance: data?.balance ?? 0,
      frozen: data?.frozen ?? false,
      last_transaction_at: data?.last_transaction_at,
    };
  },

  /**
   * Transfer VTN tokens between users within the same tenant.
   */
  async transfer(input: unknown) {
    const { tenant_id, from_user_id, to_user_id, amount, reason, idempotency_key } =
      TransferSchema.parse(input);

    const supabase = getSupabase();

    // Idempotency check
    if (idempotency_key) {
      const { data: existing } = await supabase
        .from('vtn_transactions')
        .select('id')
        .eq('idempotency_key', idempotency_key)
        .single();
      if (existing) {
        return { success: true, status: 'already_processed', idempotency_key };
      }
    }

    // Check sender balance
    const { data: wallet } = await supabase
      .from('vtn_wallets')
      .select('balance, frozen')
      .eq('tenant_id', tenant_id)
      .eq('user_id', from_user_id)
      .single();

    if (!wallet || wallet.frozen) {
      return { success: false, error: 'wallet_frozen_or_not_found' };
    }
    if (wallet.balance < amount) {
      return { success: false, error: 'insufficient_balance', balance: wallet.balance };
    }

    // Execute transfer via RPC (atomic)
    const { data, error } = await supabase.rpc('vtn_transfer', {
      p_tenant_id: tenant_id,
      p_from_user: from_user_id,
      p_to_user: to_user_id,
      p_amount: amount,
      p_reason: reason,
      p_idempotency_key: idempotency_key ?? null,
    });

    if (error) throw new Error(`transfer failed: ${error.message}`);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'vtn.transfer',
      actor: 'openclaw-autopilot',
      details: { from_user_id, to_user_id, amount, reason },
      created_at: new Date().toISOString(),
    });

    return { success: true, transaction: data };
  },

  /**
   * Distribute VTN rewards to a user.
   */
  async reward(input: unknown) {
    const { tenant_id, user_id, amount, reason, metadata } = RewardSchema.parse(input);
    const supabase = getSupabase();

    const { data, error } = await supabase.rpc('vtn_reward', {
      p_tenant_id: tenant_id,
      p_user_id: user_id,
      p_amount: amount,
      p_reason: reason,
      p_metadata: metadata ?? {},
    });

    if (error) throw new Error(`reward failed: ${error.message}`);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'vtn.reward',
      actor: 'openclaw-autopilot',
      details: { user_id, amount, reason },
      created_at: new Date().toISOString(),
    });

    return { success: true, transaction: data };
  },

  /**
   * Get transaction history for a user.
   */
  async history(input: unknown) {
    const { tenant_id, user_id, limit, type } = TransactionHistorySchema.parse(input);
    const supabase = getSupabase();

    let query = supabase
      .from('vtn_transactions')
      .select('id, type, amount, reason, counterparty_id, created_at')
      .eq('tenant_id', tenant_id)
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (type) query = query.eq('type', type);

    const { data, error } = await query;
    if (error) throw new Error(`history failed: ${error.message}`);
    return { success: true, transactions: data, count: data?.length ?? 0 };
  },

  /**
   * Spend VTN tokens on a service or marketplace item.
   */
  async spend(input: unknown) {
    const { tenant_id, user_id, amount, item, item_type, metadata } = SpendSchema.parse(input);
    const supabase = getSupabase();

    const { data, error } = await supabase.rpc('vtn_spend', {
      p_tenant_id: tenant_id,
      p_user_id: user_id,
      p_amount: amount,
      p_item: item,
      p_item_type: item_type,
      p_metadata: metadata ?? {},
    });

    if (error) throw new Error(`spend failed: ${error.message}`);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'vtn.spend',
      actor: 'openclaw-autopilot',
      details: { user_id, amount, item, item_type },
      created_at: new Date().toISOString(),
    });

    return { success: true, transaction: data };
  },
};

export const SKILL_META = {
  name: 'vitana-vtn-wallet',
  description: 'VTN token wallet: balances, transfers, rewards, spending, and transaction history',
  actions: Object.keys(actions),
};
