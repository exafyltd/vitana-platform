/**
 * Autopilot Automations Phase 1 — payments-wallet-vtn gap closure.
 *
 * AP-0704 (Subscription Expiry Warning) and AP-0712 (Spending Insights) were
 * PLANNED-only entries with no handler. AP-0703 and AP-0709 stay PLANNED
 * (no live trigger path / out-of-scope tokenomics op respectively).
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  AUTOMATION_REGISTRY,
  getAutomation,
} from '../../src/services/automation-registry';
import { getHandler } from '../../src/services/automation-executor';
import { registerWalletPaymentsHandlers } from '../../src/services/automation-handlers/wallet-payments';
import { AutomationContext } from '../../src/types/automations';

registerWalletPaymentsHandlers();

const SRC = path.join(__dirname, '..', '..', 'src', 'services', 'automation-handlers', 'wallet-payments.ts');

function makeFakeSupabase(
  resultsByTable: Record<string, Array<{ data?: any; count?: number; error?: any }>>,
  rpcResults: Record<string, { data?: any; error?: any }> = {},
) {
  const cursors: Record<string, number> = {};
  return {
    from(table: string) {
      const queue = resultsByTable[table] || [{ data: [], error: null }];
      const idx = Math.min(cursors[table] || 0, queue.length - 1);
      cursors[table] = (cursors[table] || 0) + 1;
      const result = queue[idx];
      const chain: any = {
        select: () => chain,
        insert: () => chain,
        update: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        gt: () => chain,
        contains: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        then: (resolve: any) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
    rpc(name: string) {
      return Promise.resolve(rpcResults[name] ?? { data: null, error: null });
    },
  };
}

function makeCtx(
  supabase: any,
  metadata: Record<string, unknown> = {},
  queryTargetUsers: Array<{ user_id: string; active_role: string }> = []
): { ctx: AutomationContext; notify: jest.Mock } {
  const notify = jest.fn();
  const ctx: AutomationContext = {
    tenantId: 't-1',
    targetRoles: 'all',
    supabase,
    run: {
      id: 'run-1', tenant_id: 't-1', automation_id: 'AP-TEST', trigger_type: 'heartbeat',
      target_roles: 'all', status: 'running', users_affected: 0, actions_taken: 0,
      metadata, started_at: new Date().toISOString(),
    },
    log: jest.fn(),
    notify,
    emitEvent: jest.fn(async () => {}),
    queryTargetUsers: jest.fn(async () => queryTargetUsers),
  };
  return { ctx, notify };
}

describe('registry wiring — payments-wallet-vtn', () => {
  it('AP-0704 and AP-0712 are now implemented', () => {
    expect(getAutomation('AP-0704')?.status).toBe('IMPLEMENTED');
    expect(getAutomation('AP-0704')?.handler).toBe('runSubscriptionExpiryWarning');
    expect(getHandler('runSubscriptionExpiryWarning')).toBeInstanceOf(Function);

    expect(getAutomation('AP-0712')?.status).toBe('IMPLEMENTED');
    expect(getAutomation('AP-0712')?.handler).toBe('runSpendingInsights');
    expect(getHandler('runSpendingInsights')).toBeInstanceOf(Function);
  });

  it('AP-0703 and AP-0709 stay PLANNED', () => {
    expect(getAutomation('AP-0703')?.status).toBe('PLANNED');
    expect(getAutomation('AP-0709')?.status).toBe('PLANNED');
  });

  it('no payments-wallet-vtn automation marked IMPLEMENTED is missing a handler', () => {
    for (const def of AUTOMATION_REGISTRY.filter((d) => d.domain === 'payments-wallet-vtn')) {
      if (def.status === 'IMPLEMENTED' || def.status === 'LIVE') {
        expect(def.handler).toBeTruthy();
      }
    }
  });

  it('never queries app_users by "id" (the real PK is user_id)', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).not.toMatch(/from\(['"]app_users['"]\)[\s\S]{0,150}\.eq\(['"]id['"],/);
  });
});

describe('runSubscriptionExpiryWarning (AP-0704)', () => {
  it('warns a user whose subscription will lapse within the window', async () => {
    const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const supabase = makeFakeSupabase({
      user_subscriptions: [{ data: [{ user_id: 'u1', plan_key: 'pro', current_period_end: inTwoDays }], error: null }],
      user_notifications: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runSubscriptionExpiryWarning')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('is a no-op within the cooldown window', async () => {
    const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const supabase = makeFakeSupabase({
      user_subscriptions: [{ data: [{ user_id: 'u1', plan_key: 'pro', current_period_end: inTwoDays }], error: null }],
      user_notifications: [{ data: [{ id: 'n-1' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runSubscriptionExpiryWarning')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('sends zero warnings and logs loudly when fetchExpiringSubscriptions errors, instead of treating the tenant as having no expiring subscriptions', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = makeFakeSupabase({
      user_subscriptions: [{ data: null, error: { message: 'connection reset' } }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runSubscriptionExpiryWarning')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchExpiringSubscriptions failed'));
    errorSpy.mockRestore();
  });

  it('skips a user (does not re-warn) when the cooldown check errors, instead of failing open', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const supabase = makeFakeSupabase({
      user_subscriptions: [{ data: [{ user_id: 'u1', plan_key: 'pro', current_period_end: inTwoDays }], error: null }],
      user_notifications: [{ data: null, error: { message: 'connection reset' } }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runSubscriptionExpiryWarning')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchRecentExpiryWarning failed'));
    errorSpy.mockRestore();
  });
});

describe('runCreatorStripeOnboarding (AP-0706)', () => {
  it('does not send a false "already onboarded" or a false onboarding nudge when fetchStripeAccountStatus errors', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = makeFakeSupabase({
      app_users: [{ data: null, error: { message: 'connection reset' } }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1' });
    const handler = getHandler('runCreatorStripeOnboarding')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchStripeAccountStatus failed'));
    errorSpy.mockRestore();
  });

  it('nudges a creator who has no Stripe account yet, on a successful lookup', async () => {
    const supabase = makeFakeSupabase({
      app_users: [{ data: { stripe_account_id: null, stripe_charges_enabled: false }, error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1' });
    const handler = getHandler('runCreatorStripeOnboarding')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });
});

describe('runSpendingInsights (AP-0712)', () => {
  it('summarizes last month\'s completed spend for a user', async () => {
    const supabase = makeFakeSupabase({
      wallet_transactions: [{ data: [{ amount: 50, from_currency: 'CREDITS' }, { amount: 20, from_currency: 'CREDITS' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'community' }]);
    const handler = getHandler('runSpendingInsights')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('skips users with no spend last month', async () => {
    const supabase = makeFakeSupabase({
      wallet_transactions: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, {}, [{ user_id: 'u1', active_role: 'community' }]);
    const handler = getHandler('runSpendingInsights')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runWalletCreditReward (AP-0708) — credit_wallet error handling', () => {
  // 2026-08-29 fix (AURORA-B3-RPC-PARITY-INVENTORY.md addendum): credit_wallet
  // is a confirmed-dead RPC. supabase-js's .rpc() resolves normally with an
  // {error} field on a Postgres-level failure rather than throwing, so this
  // handler used to silently report a successful action even when nothing
  // was credited. These tests pin the corrected, honest behavior.

  it('on the RPC returning {error}: logs it via ctx.log, does not notify or emit, and reports zero actions', async () => {
    const supabase = makeFakeSupabase({}, {
      credit_wallet: { data: null, error: { message: 'function credit_wallet(...) does not exist' } },
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', reward_type: 'product_review' });
    const handler = getHandler('runWalletCreditReward')!;

    const result = await handler(ctx);

    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringContaining('credit_wallet RPC returned an error for product_review/u1'),
    );
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('function credit_wallet(...) does not exist'));
    expect(notify).not.toHaveBeenCalled();
    expect(ctx.emitEvent).not.toHaveBeenCalled();
    // The bug this fix closes: this used to unconditionally return
    // { usersAffected: 1, actionsTaken: 1 } regardless of whether the
    // credit actually happened.
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('on a duplicate reward: logs it and reports zero actions (unchanged behavior)', async () => {
    const supabase = makeFakeSupabase({}, {
      credit_wallet: { data: { duplicate: true }, error: null },
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', reward_type: 'product_review' });
    const handler = getHandler('runWalletCreditReward')!;

    const result = await handler(ctx);

    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('Duplicate reward blocked: product_review for u1'));
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });

  it('on a successful credit: notifies, emits the event, and reports one action', async () => {
    const supabase = makeFakeSupabase({}, {
      credit_wallet: { data: { ok: true, balance: 125 }, error: null },
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', reward_type: 'product_review' });
    const handler = getHandler('runWalletCreditReward')!;

    const result = await handler(ctx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(ctx.emitEvent).toHaveBeenCalledWith(
      'autopilot.wallet.credits_awarded',
      expect.objectContaining({ user_id: 'u1', reward_type: 'product_review', amount: 25, balance: 125 }),
    );
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('returns zero actions immediately for an unknown reward_type, without calling credit_wallet', async () => {
    const supabase = makeFakeSupabase({}, {
      credit_wallet: { data: { ok: true, balance: 1 }, error: null },
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', reward_type: 'not_a_real_reward' });
    const handler = getHandler('runWalletCreditReward')!;

    const result = await handler(ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});
