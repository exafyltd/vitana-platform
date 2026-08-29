import * as repo from '../../src/routes/billing-repository';

/**
 * Functional stub Supabase client — a from()-chain that records every call
 * and resolves to a configurable {data,error,count} response, matching the
 * pattern used for the other B1 repository tests.
 */
function makeSupabaseStub(response: { data?: any; error?: any; count?: number | null } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  const resolved = { data: response.data ?? null, error: response.error ?? null, count: response.count ?? null };

  const chain: any = {};
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return chain;
  };
  for (const m of [
    'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'like', 'or',
    'order', 'limit', 'range', 'filter', 'update', 'insert', 'upsert', 'delete',
  ]) {
    chain[m] = record(m);
  }
  chain.single = jest.fn(() => Promise.resolve(resolved));
  chain.maybeSingle = jest.fn(() => Promise.resolve(resolved));
  chain.then = (onResolve: (v: any) => void) => Promise.resolve(resolved).then(onResolve);

  const from = jest.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return chain;
  });
  const rpc = jest.fn((fn: string, args?: any) => {
    calls.push({ method: 'rpc', args: [fn, args] });
    return Promise.resolve(resolved);
  });

  return { from, rpc, calls, chain };
}

describe('billing-repository', () => {
  describe('fetchActivePriceByKey / fetchActiveCreditPackByKey', () => {
    it('scopes prices to price_key + is_active', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchActivePriceByKey(sb as any, 'plan-monthly');
      expect(sb.from).toHaveBeenCalledWith('subscription_plan_prices');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['price_key', 'plan-monthly'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['is_active', true] });
    });

    it('scopes credit packs to pack_key + is_active', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchActiveCreditPackByKey(sb as any, 'pack-100');
      expect(sb.from).toHaveBeenCalledWith('credit_packs');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['pack_key', 'pack-100'] });
    });
  });

  describe('fetchUserSubscription / upsertUserSubscriptionCustomerId', () => {
    it('reads the tenant+user row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchUserSubscription(sb as any, { tenantId: 't1', userId: 'u1' });
      expect(sb.from).toHaveBeenCalledWith('user_subscriptions');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });

    it('upserts on the tenant_id,user_id conflict key', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { tenant_id: 't1', user_id: 'u1' };
      await repo.upsertUserSubscriptionCustomerId(sb as any, row);
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'tenant_id,user_id' }] });
    });
  });

  describe('GET /me helpers', () => {
    it('fetchWalletBalances scopes tenant + user', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchWalletBalances(sb as any, { tenantId: 't1', userId: 'u1' });
      expect(sb.from).toHaveBeenCalledWith('wallet_balances');
    });

    it('fetchFeatureEntitlements scopes to plan_key', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchFeatureEntitlements(sb as any, 'premium');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['plan_key', 'premium'] });
    });

    it('rpcGetFeatureUsageInWindow passes p_ params for the given window', async () => {
      const sb = makeSupabaseStub();
      await repo.rpcGetFeatureUsageInWindow(sb as any, { tenantId: 't1', userId: 'u1', featureKey: 'ai_chat', windowSeconds: 18000 });
      expect(sb.rpc).toHaveBeenCalledWith('fn_get_feature_usage_in_window', {
        p_tenant_id: 't1', p_user_id: 'u1', p_feature_key: 'ai_chat', p_window_seconds: 18000,
      });
    });

    it('rpcGetFeatureUsage passes p_ params for the monthly window', async () => {
      const sb = makeSupabaseStub();
      await repo.rpcGetFeatureUsage(sb as any, { tenantId: 't1', userId: 'u1', featureKey: 'ai_chat', windowSeconds: 2592000 });
      expect(sb.rpc).toHaveBeenCalledWith('fn_get_feature_usage', {
        p_tenant_id: 't1', p_user_id: 'u1', p_feature_key: 'ai_chat', p_window_seconds: 2592000,
      });
    });

    it('fetchYearEarningTransactions scopes to type=earning since year start', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchYearEarningTransactions(sb as any, { tenantId: 't1', userId: 'u1', yearStart: '2026-01-01T00:00:00.000Z' });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['type', 'earning'] });
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['created_at', '2026-01-01T00:00:00.000Z'] });
    });
  });

  describe('fetchSubscriptionPlanTrialDays', () => {
    it('reads trial_days for the plan', async () => {
      const sb = makeSupabaseStub({ data: { trial_days: 14 } });
      await repo.fetchSubscriptionPlanTrialDays(sb as any, 'premium');
      expect(sb.from).toHaveBeenCalledWith('subscription_plans');
      expect(sb.calls).toContainEqual({ method: 'select', args: ['trial_days'] });
    });
  });

  describe('rpcRedeemCode', () => {
    it('passes tenant/user/code as p_ params', async () => {
      const sb = makeSupabaseStub();
      await repo.rpcRedeemCode(sb as any, { tenantId: 't1', userId: 'u1', code: 'ABC-123' });
      expect(sb.rpc).toHaveBeenCalledWith('fn_redeem_code', { p_tenant_id: 't1', p_user_id: 'u1', p_code: 'ABC-123' });
    });
  });

  describe('fetchLatestFoundingCampaignCode', () => {
    it('scopes to the founding_500 campaign, newest first', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchLatestFoundingCampaignCode(sb as any);
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['campaign', 'founding_500'] });
      expect(sb.calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] });
      expect(sb.calls).toContainEqual({ method: 'limit', args: [1] });
    });
  });

  describe('processed_stripe_events idempotency ledger', () => {
    it('insertProcessedStripeEvent writes event_id + event_type', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.insertProcessedStripeEvent(sb as any, { eventId: 'evt_1', eventType: 'checkout.session.completed' });
      expect(sb.from).toHaveBeenCalledWith('processed_stripe_events');
      expect(sb.calls).toContainEqual({ method: 'insert', args: [{ event_id: 'evt_1', event_type: 'checkout.session.completed' }] });
    });

    it('deleteProcessedStripeEvent removes by event_id (webhook-processing-failed rollback)', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.deleteProcessedStripeEvent(sb as any, 'evt_1');
      expect(sb.calls).toContainEqual({ method: 'delete', args: [] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['event_id', 'evt_1'] });
    });
  });

  describe('rpcCreditWallet — known dead RPC, pass-through only', () => {
    it('forwards all p_ params unchanged', async () => {
      const sb = makeSupabaseStub();
      await repo.rpcCreditWallet(sb as any, {
        tenantId: 't1', userId: 'u1', amount: 100, type: 'purchase',
        source: 'credit_pack:pack-100', sourceEventId: 'sess_1', description: 'desc',
      });
      expect(sb.rpc).toHaveBeenCalledWith('credit_wallet', {
        p_tenant_id: 't1', p_user_id: 'u1', p_amount: 100, p_type: 'purchase',
        p_source: 'credit_pack:pack-100', p_source_event_id: 'sess_1', p_description: 'desc',
      });
    });
  });

  describe('subscription upsert/update helpers', () => {
    it('fetchPlanPriceByStripePriceId looks up by stripe_price_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchPlanPriceByStripePriceId(sb as any, 'price_123');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['stripe_price_id', 'price_123'] });
    });

    it('upsertUserSubscriptionFromStripe upserts on tenant_id,user_id', async () => {
      const sb = makeSupabaseStub({ data: null });
      const row = { tenant_id: 't1', user_id: 'u1' };
      await repo.upsertUserSubscriptionFromStripe(sb as any, row);
      expect(sb.calls).toContainEqual({ method: 'upsert', args: [row, { onConflict: 'tenant_id,user_id' }] });
    });

    it('updateUserSubscriptionStatus scopes the patch to tenant + user', async () => {
      const sb = makeSupabaseStub({ data: null });
      const patch = { status: 'past_due' };
      await repo.updateUserSubscriptionStatus(sb as any, { tenantId: 't1', userId: 'u1', patch });
      expect(sb.calls).toContainEqual({ method: 'update', args: [patch] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['tenant_id', 't1'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['user_id', 'u1'] });
    });
  });

  describe('admin redemption-codes helpers', () => {
    it('fetchPlanByKey reads plan_key', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchPlanByKey(sb as any, 'premium');
      expect(sb.from).toHaveBeenCalledWith('subscription_plans');
    });

    it('insertRedemptionCodes inserts the whole batch', async () => {
      const sb = makeSupabaseStub({ data: null });
      const rows = [{ code: 'A' }, { code: 'B' }];
      await repo.insertRedemptionCodes(sb as any, rows);
      expect(sb.calls).toContainEqual({ method: 'insert', args: [rows] });
    });

    it('listRedemptionCodes paginates and orders newest first, no campaign filter when null', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listRedemptionCodes(sb as any, { campaign: null, offset: 0, limit: 100 });
      expect(sb.calls).toContainEqual({ method: 'range', args: [0, 99] });
      expect(sb.calls.some((c) => c.method === 'eq' && c.args[0] === 'campaign')).toBe(false);
    });

    it('listRedemptionCodes applies the campaign filter when given', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.listRedemptionCodes(sb as any, { campaign: 'founding_500', offset: 0, limit: 100 });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['campaign', 'founding_500'] });
    });

    it('updateRedemptionCodeActive updates by code and selects the result back', async () => {
      const sb = makeSupabaseStub({ data: { code: 'A', is_active: false } });
      await repo.updateRedemptionCodeActive(sb as any, { code: 'A', isActive: false });
      expect(sb.calls).toContainEqual({ method: 'update', args: [{ is_active: false }] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['code', 'A'] });
    });
  });

  describe('admin/metrics helpers', () => {
    it('fetchActiveOrTrialingSubscriptions filters the three live statuses', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchActiveOrTrialingSubscriptions(sb as any);
      expect(sb.calls).toContainEqual({ method: 'in', args: ['status', ['active', 'trialing', 'past_due']] });
    });

    it('fetchActiveMonthlyPlanPrices scopes to month + active', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchActiveMonthlyPlanPrices(sb as any);
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['billing_interval', 'month'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['is_active', true] });
    });

    it('fetchVoiceDegradeEventsSince scopes to the specific action + feature_key', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchVoiceDegradeEventsSince(sb as any, 'SINCE');
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['action', 'degraded'] });
      expect(sb.calls).toContainEqual({ method: 'eq', args: ['feature_key', 'voice_live_minutes'] });
    });

    it('fetchRedemptionsSince scopes to redeemed_at', async () => {
      const sb = makeSupabaseStub({ data: [] });
      await repo.fetchRedemptionsSince(sb as any, 'SINCE');
      expect(sb.calls).toContainEqual({ method: 'gte', args: ['redeemed_at', 'SINCE'] });
    });

    it('fetchTenantSettingsFeatureFlags reads a single row', async () => {
      const sb = makeSupabaseStub({ data: null });
      await repo.fetchTenantSettingsFeatureFlags(sb as any);
      expect(sb.from).toHaveBeenCalledWith('tenant_settings');
    });
  });
});
