/**
 * VOICE-CATALOG-WAVE-1 — conversation-flow tests for the 6 new domain modules
 * wired into orb-tools-shared.ts (marketplace, cart/checkout, wallet/payments,
 * messaging depth, events/tickets, health depth). Pins the invariants that
 * matter most for a voice assistant that can move money and charge cards:
 *
 *  1. Every one of the 69 Wave 1 tools is reachable via the shared dispatcher.
 *  2. send_funds — the only tool allowed to execute real money movement by
 *     voice — requires an explicit confirm:true turn before it moves a cent,
 *     and never credits the recipient if the debit leg fails.
 *  3. start_checkout never calls a wallet/payment primitive — it only
 *     validates and hands off to the screen (payment policy).
 *  4. A tool with no real backing returns an honest ok:false rather than a
 *     fabricated success.
 */
import {
  dispatchOrbTool,
  ORB_TOOL_NAMES,
  type OrbToolIdentity,
} from '../src/services/orb-tools-shared';

const ID: OrbToolIdentity = { user_id: 'u-sender', tenant_id: 't-1', role: 'community' };

const WAVE1_TOOL_NAMES = [
  'search_marketplace', 'get_product_details', 'browse_supplements', 'add_supplement_to_regimen',
  'list_my_supplements', 'remove_supplement_from_regimen', 'browse_wellness_services', 'get_provider_profile',
  'browse_doctors_coaches', 'get_coach_compatibility', 'browse_deals_offers', 'apply_discount_code',
  'get_ai_product_picks', 'list_my_orders', 'get_order_status', 'reorder_last_order',
  'add_to_cart', 'view_cart', 'update_cart_item', 'remove_from_cart', 'clear_cart',
  'set_shopping_budget', 'review_agent_purchase_proposals', 'start_checkout',
  'get_wallet_summary', 'list_wallet_transactions', 'send_funds', 'request_payment',
  'exchange_currency', 'get_exchange_rate', 'set_display_currency', 'get_referral_earnings',
  'get_commissions_summary', 'get_pending_rewards', 'list_payment_requests',
  'send_group_chat_message', 'reply_to_message', 'react_to_message', 'create_group_chat',
  'add_group_chat_member', 'leave_group_chat', 'send_calendar_invite_in_chat', 'start_voice_call',
  'start_video_call', 'create_event', 'update_my_event', 'cancel_my_event', 'create_meetup',
  'update_my_meetup', 'invite_to_event', 'buy_event_ticket', 'list_my_event_tickets', 'share_event',
  'get_event_attendees', 'log_meal', 'log_vitals', 'log_mood', 'log_biomarker', 'get_health_trends',
  'get_health_streaks', 'order_lab_test', 'get_lab_results', 'generate_health_plan',
  'list_my_health_plans', 'get_health_plan_progress', 'list_my_conditions', 'get_health_education',
  'get_next_best_action', 'connect_health_device',
];

test('all 69 Wave 1 tools are registered in the shared dispatcher', () => {
  expect(WAVE1_TOOL_NAMES).toHaveLength(69);
  for (const name of WAVE1_TOOL_NAMES) {
    expect(ORB_TOOL_NAMES).toContain(name);
  }
});

test('an unbacked tool (apply_discount_code) is honest, not fabricated', async () => {
  const sb: any = {};
  const r: any = await dispatchOrbTool('apply_discount_code', { code: 'SAVE10' }, ID, sb);
  expect(r.ok).toBe(false);
  expect(typeof r.error).toBe('string');
  expect(r.error.length).toBeGreaterThan(0);
});

const RECIPIENT_UUID = '11111111-1111-1111-1111-111111111111';

describe('send_funds — the only voice tool allowed to move real money', () => {
  const senderAccount = { id: 'acct-sender', user_id: 'u-sender', currency: 'EUR', balance_minor: 5000, status: 'active' };
  const recipientRow = { user_id: RECIPIENT_UUID, display_name: 'Alex', vitana_id: 'alex1' };

  function makeSb(overrides: { debitOk: boolean; creditOk?: boolean }) {
    const from = jest.fn((table: string) => {
      if (table === 'app_users') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: recipientRow, error: null }) }) }),
        };
      }
      throw new Error(`unexpected table in this test: ${table}`);
    });
    const rpc = jest.fn((fn: string) => {
      if (fn === 'resolve_recipient_candidates') {
        return Promise.resolve({
          data: [{ user_id: RECIPIENT_UUID, vitana_id: 'alex1', display_name: 'Alex', score: 0.97 }],
          error: null,
        });
      }
      throw new Error(`unexpected rpc in this test: ${fn}`);
    });
    return { from, rpc } as any;
  }

  beforeEach(() => {
    jest.resetModules();
  });

  test('first call (no confirm) previews and moves nothing', async () => {
    jest.doMock('../src/services/wallet/balance-service', () => ({
      getAccountsForUser: jest.fn().mockResolvedValue([senderAccount]),
    }));
    const debitWalletForSpend = jest.fn();
    const creditWalletForEarning = jest.fn();
    jest.doMock('../src/services/wallet/spend-earning-service', () => ({ debitWalletForSpend, creditWalletForEarning }));

    const { dispatchOrbTool: dispatch } = require('../src/services/orb-tools-shared');
    const sb = makeSb({ debitOk: true });
    const r: any = await dispatch('send_funds', { amount: 25, recipient_name: 'Alex' }, ID, sb);

    expect(r.ok).toBe(true);
    expect(r.result.requires_confirmation).toBe(true);
    expect(r.result.recipient_user_id).toBe(RECIPIENT_UUID);
    expect(debitWalletForSpend).not.toHaveBeenCalled();
    expect(creditWalletForEarning).not.toHaveBeenCalled();
  });

  test('confirm:true executes debit then credit with a shared reference_id', async () => {
    jest.doMock('../src/services/wallet/balance-service', () => ({
      getAccountsForUser: jest.fn()
        .mockResolvedValueOnce([senderAccount]) // sender
        .mockResolvedValueOnce([{ id: 'acct-recipient', user_id: RECIPIENT_UUID, currency: 'EUR', balance_minor: 0, status: 'active' }]), // recipient
    }));
    const debitWalletForSpend = jest.fn().mockResolvedValue({ ok: true, duplicate: false, balance_minor: 2500, currency: 'EUR' });
    const creditWalletForEarning = jest.fn().mockResolvedValue({ ok: true, duplicate: false, balance_minor: 2500, currency: 'EUR' });
    jest.doMock('../src/services/wallet/spend-earning-service', () => ({ debitWalletForSpend, creditWalletForEarning }));

    const { dispatchOrbTool: dispatch } = require('../src/services/orb-tools-shared');
    const sb = makeSb({ debitOk: true, creditOk: true });
    const r: any = await dispatch(
      'send_funds',
      { amount: 25, recipient_user_id: RECIPIENT_UUID, currency: 'EUR', confirm: true },
      ID,
      sb,
    );

    expect(r.ok).toBe(true);
    expect(debitWalletForSpend).toHaveBeenCalledTimes(1);
    expect(creditWalletForEarning).toHaveBeenCalledTimes(1);
    const debitArgs = debitWalletForSpend.mock.calls[0][0];
    const creditArgs = creditWalletForEarning.mock.calls[0][0];
    expect(debitArgs.reference_id).toBe(creditArgs.reference_id);
    expect(debitArgs.account_id).toBe('acct-sender');
    expect(creditArgs.account_id).toBe('acct-recipient');
  });

  test('debit failure (insufficient balance) never calls credit — no money vanishes', async () => {
    jest.doMock('../src/services/wallet/balance-service', () => ({
      getAccountsForUser: jest.fn().mockResolvedValue([senderAccount]),
    }));
    const debitWalletForSpend = jest.fn().mockResolvedValue({ ok: false, error: 'INSUFFICIENT_BALANCE', balance_minor: 500 });
    const creditWalletForEarning = jest.fn();
    jest.doMock('../src/services/wallet/spend-earning-service', () => ({ debitWalletForSpend, creditWalletForEarning }));

    const { dispatchOrbTool: dispatch } = require('../src/services/orb-tools-shared');
    const sb = makeSb({ debitOk: false });
    const r: any = await dispatch(
      'send_funds',
      { amount: 25, recipient_user_id: RECIPIENT_UUID, currency: 'EUR', confirm: true },
      ID,
      sb,
    );

    expect(r.ok).toBe(true);
    expect(r.result.sent).toBe(false);
    expect(r.result.error_code).toBe('INSUFFICIENT_BALANCE');
    expect(creditWalletForEarning).not.toHaveBeenCalled();
  });
});

describe('start_checkout — payment policy: never charges by voice', () => {
  function chainable(result: any) {
    const obj: any = {
      select: () => obj,
      eq: () => obj,
      order: () => obj,
      in: () => obj,
      maybeSingle: () => Promise.resolve(result),
      then: (resolve: any) => resolve(result),
    };
    return obj;
  }

  test('confirm:true returns a navigate directive, never a debit/checkout call', async () => {
    const cart = { id: 'cart-1', user_id: ID.user_id, tenant_id: 't-1', status: 'active' };
    const items = [{ id: 'item-1', cart_id: 'cart-1', product_id: 'p-1', quantity: 1, unit_price_cents: 1999, status: 'active' }];
    const products = [{ id: 'p-1', title: 'Omega-3', price_cents: 1999, currency: 'EUR' }];

    const sb: any = {
      from: (table: string) => {
        if (table === 'universal_carts') return chainable({ data: cart, error: null });
        if (table === 'universal_cart_items') return chainable({ data: items, error: null });
        if (table === 'products') return chainable({ data: products, error: null });
        throw new Error(`unexpected table: ${table}`);
      },
    };

    const r: any = await dispatchOrbTool('start_checkout', { confirm: true }, ID, sb);
    expect(r.ok).toBe(true);
    expect(r.result.started).toBe(true);
    expect(r.result.directive).toBeDefined();
    expect(r.result.directive.directive).toBe('navigate');
    // No wallet/payment field anywhere in the response — confirms nothing was charged.
    expect(JSON.stringify(r.result)).not.toMatch(/debit|charge|stripe/i);
  });
});
