/**
 * Autopilot Automations — gap-closure follow-up.
 *
 * business-marketplace.ts: fixes AP-1101/1102/1104/1105/1107/1110 against
 * real substitutes (live_rooms/products/product_orders/live_room_attendance)
 * for the never-deployed services_catalog/products_catalog/user_offers_memory/
 * usage_outcomes (VTID-01092).
 *
 * wallet-payments.ts: fixes AP-0708 (credit_wallet -> increment_wallet_balance
 * + user_notifications-based idempotency) and AP-0711 (user_offers_memory ->
 * service_payments transaction count).
 */

import * as fs from 'fs';
import * as path from 'path';

import { getHandler } from '../../src/services/automation-executor';
import { registerBusinessMarketplaceHandlers } from '../../src/services/automation-handlers/business-marketplace';
import { registerWalletPaymentsHandlers } from '../../src/services/automation-handlers/wallet-payments';
import { AutomationContext } from '../../src/types/automations';

registerBusinessMarketplaceHandlers();
registerWalletPaymentsHandlers();

const MARKETPLACE_SRC = path.join(__dirname, '..', '..', 'src', 'services', 'automation-handlers', 'business-marketplace.ts');
const WALLET_SRC = path.join(__dirname, '..', '..', 'src', 'services', 'automation-handlers', 'wallet-payments.ts');

function makeFakeSupabase(resultsByTable: Record<string, Array<{ data?: any; count?: number; error?: any }>>) {
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
        upsert: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        overlaps: () => chain,
        gte: () => chain,
        lte: () => chain,
        contains: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        then: (resolve: any) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
    rpc: jest.fn(async () => ({ data: 150, error: null })),
  };
}

function makeCtx(supabase: any, metadata: Record<string, unknown> = {}) {
  const notify = jest.fn();
  const ctx: AutomationContext = {
    tenantId: 't-1',
    targetRoles: 'all',
    supabase,
    run: {
      id: 'run-1', tenant_id: 't-1', automation_id: 'AP-TEST', trigger_type: 'event',
      target_roles: 'all', status: 'running', users_affected: 0, actions_taken: 0,
      metadata, started_at: new Date().toISOString(),
    },
    log: jest.fn(),
    notify,
    emitEvent: jest.fn(async () => {}),
    queryTargetUsers: jest.fn(async () => []),
  };
  return { ctx, notify };
}

describe('business-marketplace — source-level wall against never-deployed tables', () => {
  const src = fs.readFileSync(MARKETPLACE_SRC, 'utf8');

  it('never references services_catalog/products_catalog/user_offers_memory/usage_outcomes', () => {
    expect(src).not.toMatch(/from\(['"]services_catalog['"]\)/);
    expect(src).not.toMatch(/from\(['"]products_catalog['"]\)/);
    expect(src).not.toMatch(/from\(['"]user_offers_memory['"]\)/);
    expect(src).not.toMatch(/from\(['"]usage_outcomes['"]\)/);
  });

  it('uses the real live substitutes instead', () => {
    expect(src).toContain("from('live_rooms')");
    expect(src).toContain("from('products')");
    expect(src).toContain("from('product_orders')");
    expect(src).toContain("from('live_room_attendance')");
  });
});

describe('runServiceListingDistribution (AP-1101)', () => {
  it('notifies users whose interests match the listed live_room', async () => {
    const supabase = makeFakeSupabase({
      live_rooms: [{ data: { title: 'Pilates Basics', category: 'pilates', topic_keys: [], host_user_id: 'host-1' }, error: null }],
      user_interests: [{ data: [{ user_id: 'u1', interest: 'pilates' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { service_id: 'room-1', user_id: 'host-1' });
    const handler = getHandler('runServiceListingDistribution')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 2 });
  });
});

describe('runProductAiPicksMatching (AP-1102)', () => {
  it('notifies users with a matching recommendation category', async () => {
    const supabase = makeFakeSupabase({
      products: [{ data: { title: 'Omega-3', category: 'nutrition', topic_keys: [] }, error: null }],
      recommendations: [{ data: [{ user_id: 'u1' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { product_id: 'prod-1' });
    const handler = getHandler('runProductAiPicksMatching')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 2 });
  });
});

describe('runClientServiceMatching (AP-1104)', () => {
  it('notifies the user when scheduled sessions match the requested category', async () => {
    const supabase = makeFakeSupabase({
      live_rooms: [{ data: [{ id: 'r1', title: 'Coaching', category: 'coach' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', service_type: 'coach' });
    const handler = getHandler('runClientServiceMatching')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });
});

describe('runPostServiceOutcomeTracking (AP-1105)', () => {
  it('asks attendees from 7-8 days ago who have not been asked yet', async () => {
    const supabase = makeFakeSupabase({
      live_room_attendance: [{ data: [{ user_id: 'u1', live_room_id: 'r1' }], error: null }],
      user_notifications: [{ data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runPostServiceOutcomeTracking')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('skips attendees already asked', async () => {
    const supabase = makeFakeSupabase({
      live_room_attendance: [{ data: [{ user_id: 'u1', live_room_id: 'r1' }], error: null }],
      user_notifications: [{ data: [{ id: 'n1' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runPostServiceOutcomeTracking')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runProductReviewFollowUp (AP-1107)', () => {
  it('asks buyers from 14-15 days ago for a review', async () => {
    const supabase = makeFakeSupabase({
      product_orders: [{ data: [{ user_id: 'u1', product_id: 'p1' }], error: null }],
      products: [{ data: { title: 'Omega-3' }, error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runProductReviewFollowUp')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });
});

describe('runCrossSellServiceToProductBuyers (AP-1110)', () => {
  it('suggests a matching live_room by shared topic_keys', async () => {
    const supabase = makeFakeSupabase({
      products: [{ data: { topic_keys: ['recovery'] }, error: null }],
      live_rooms: [{ data: { id: 'r1', category: 'recovery' }, error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', product_id: 'p1' });
    const handler = getHandler('runCrossSellServiceToProductBuyers')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });
});

describe('wallet-payments — source-level wall', () => {
  const src = fs.readFileSync(WALLET_SRC, 'utf8');

  it('AP-0708 no longer calls the nonexistent credit_wallet RPC', () => {
    expect(src).not.toContain("rpc('credit_wallet'");
  });

  it('AP-0711 no longer references user_offers_memory', () => {
    expect(src).not.toMatch(/from\(['"]user_offers_memory['"]\)/);
  });
});

describe('runWalletCreditReward (AP-0708)', () => {
  it('credits the wallet and notifies on a fresh reward', async () => {
    const supabase = makeFakeSupabase({});
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', reward_type: 'complete_onboarding', event_id: 'evt-1' });
    const handler = getHandler('runWalletCreditReward')!;
    const result = await handler(ctx);
    expect(supabase.rpc).toHaveBeenCalledWith('increment_wallet_balance', expect.objectContaining({ p_user_id: 'u1', p_currency_type: 'CREDITS' }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });

  it('blocks a duplicate reward for the same source_event_id', async () => {
    const supabase = makeFakeSupabase({
      user_notifications: [{ data: [{ id: 'n1' }], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase, { user_id: 'u1', reward_type: 'complete_onboarding', event_id: 'evt-1' });
    const handler = getHandler('runWalletCreditReward')!;
    const result = await handler(ctx);
    expect(notify).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(result).toEqual({ usersAffected: 0, actionsTaken: 0 });
  });
});

describe('runCreatorWeeklyEarnings (AP-0711)', () => {
  it('counts real service_payments transactions for a creator', async () => {
    const supabase = makeFakeSupabase({
      app_users: [{ data: [{ user_id: 'u1', display_name: 'Alex', vitana_id: 'vt-1' }], error: null }],
      service_payments: [{ count: 3, data: [], error: null }],
    });
    const { ctx, notify } = makeCtx(supabase);
    const handler = getHandler('runCreatorWeeklyEarnings')!;
    const result = await handler(ctx);
    expect(notify).toHaveBeenCalledWith('u1', 'orb_proactive_message', expect.objectContaining({
      body: expect.stringContaining('3 transactions'),
    }));
    expect(result).toEqual({ usersAffected: 1, actionsTaken: 1 });
  });
});
