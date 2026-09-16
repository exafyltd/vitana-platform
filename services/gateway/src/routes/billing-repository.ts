// impact-allow-no-test
// Genuinely tested via test/routes/billing-repository.test.ts, which drives
// a functional stub Supabase client (a from()-chain resolving to a
// configurable {data,error,count} response) — not a wholesale module mock.
/**
 * routes/billing.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in billing.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param), same convention as every other *-repository.ts in this directory.
 *
 * This is real Stripe/wallet payment code — see billing.ts's own header and
 * docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md for the already-known `credit_wallet`
 * dead-RPC finding. `rpcCreditWallet` below is a pure pass-through of that
 * existing (already-broken) call — this file does not attempt to fix or
 * paper over that finding, which needs a human product decision, not a
 * mechanical move.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// readPriceByKey / readPackByKey / readUserSubscription / ensureStripeCustomer
// ---------------------------------------------------------------------------

export function fetchActivePriceByKey(sb: any, priceKey: string) {
  return sb
    .from('subscription_plan_prices')
    .select('price_key, plan_key, billing_interval, price_cents, currency, stripe_price_id')
    .eq('price_key', priceKey)
    .eq('is_active', true)
    .maybeSingle();
}

export function fetchActiveCreditPackByKey(sb: any, packKey: string) {
  return sb
    .from('credit_packs')
    .select('pack_key, display_name, credits, bonus_credits, price_cents, currency, stripe_price_id')
    .eq('pack_key', packKey)
    .eq('is_active', true)
    .maybeSingle();
}

export function fetchUserSubscription(sb: any, args: { tenantId: string; userId: string }) {
  return sb
    .from('user_subscriptions')
    .select('*')
    .eq('tenant_id', args.tenantId)
    .eq('user_id', args.userId)
    .maybeSingle();
}

export function upsertUserSubscriptionCustomerId(sb: any, row: Record<string, unknown>) {
  return sb.from('user_subscriptions').upsert(row, { onConflict: 'tenant_id,user_id' });
}

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------

export function fetchWalletBalances(sb: any, args: { tenantId: string; userId: string }) {
  return sb
    .from('wallet_balances')
    .select('purchased_credits, reward_credits, cash_balance, balance')
    .eq('tenant_id', args.tenantId)
    .eq('user_id', args.userId)
    .maybeSingle();
}

export function fetchFeatureEntitlements(sb: any, planKey: string) {
  return sb
    .from('feature_entitlements')
    .select('feature_key, quota, window_seconds, window_5h_quota, weekly_quota, unit, behavior_on_exceed')
    .eq('plan_key', planKey);
}

export function rpcGetFeatureUsageInWindow(
  sb: any,
  args: { tenantId: string; userId: string; featureKey: string; windowSeconds: number },
) {
  return sb.rpc('fn_get_feature_usage_in_window', {
    p_tenant_id: args.tenantId,
    p_user_id: args.userId,
    p_feature_key: args.featureKey,
    p_window_seconds: args.windowSeconds,
  });
}

export function rpcGetFeatureUsage(
  sb: any,
  args: { tenantId: string; userId: string; featureKey: string; windowSeconds: number },
) {
  return sb.rpc('fn_get_feature_usage', {
    p_tenant_id: args.tenantId,
    p_user_id: args.userId,
    p_feature_key: args.featureKey,
    p_window_seconds: args.windowSeconds,
  });
}

export function fetchYearEarningTransactions(sb: any, args: { tenantId: string; userId: string; yearStart: string }) {
  return sb
    .from('wallet_transactions')
    .select('amount, created_at')
    .eq('tenant_id', args.tenantId)
    .eq('user_id', args.userId)
    .eq('type', 'earning')
    .gte('created_at', args.yearStart);
}

// ---------------------------------------------------------------------------
// POST /checkout/subscription
// ---------------------------------------------------------------------------

export function fetchSubscriptionPlanTrialDays(sb: any, planKey: string) {
  return sb.from('subscription_plans').select('trial_days').eq('plan_key', planKey).maybeSingle();
}

// ---------------------------------------------------------------------------
// POST /redeem
// ---------------------------------------------------------------------------

export function rpcRedeemCode(sb: any, args: { tenantId: string; userId: string; code: string }) {
  return sb.rpc('fn_redeem_code', {
    p_tenant_id: args.tenantId,
    p_user_id: args.userId,
    p_code: args.code,
  });
}

// ---------------------------------------------------------------------------
// GET /founding-status
// ---------------------------------------------------------------------------

export function fetchLatestFoundingCampaignCode(sb: any) {
  return sb
    .from('redemption_codes')
    .select('code, max_uses, uses_count, is_active, expires_at, campaign, metadata')
    .eq('campaign', 'founding_500')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

// ---------------------------------------------------------------------------
// POST /webhooks/stripe — idempotency ledger
// ---------------------------------------------------------------------------

export function insertProcessedStripeEvent(sb: any, args: { eventId: string; eventType: string }) {
  return sb.from('processed_stripe_events').insert({ event_id: args.eventId, event_type: args.eventType });
}

export function deleteProcessedStripeEvent(sb: any, eventId: string) {
  return sb.from('processed_stripe_events').delete().eq('event_id', eventId);
}

// ---------------------------------------------------------------------------
// Webhook handlers
// ---------------------------------------------------------------------------

/**
 * Pass-through of the existing `credit_wallet` RPC call — deliberately NOT
 * fixed here. Per docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md, this RPC does not
 * exist live on Supabase (or Aurora); the caller already handles the error
 * by logging loudly and throwing (triggering Stripe's webhook retry), so
 * this move changes nothing about that known, already-flagged behavior.
 */
export function rpcCreditWallet(
  sb: any,
  args: { tenantId: string; userId: string; amount: number; type: string; source: string; sourceEventId: string; description: string },
) {
  return sb.rpc('credit_wallet', {
    p_tenant_id: args.tenantId,
    p_user_id: args.userId,
    p_amount: args.amount,
    p_type: args.type,
    p_source: args.source,
    p_source_event_id: args.sourceEventId,
    p_description: args.description,
  });
}

export function fetchPlanPriceByStripePriceId(sb: any, stripePriceId: string) {
  return sb.from('subscription_plan_prices').select('plan_key, price_key').eq('stripe_price_id', stripePriceId).maybeSingle();
}

export function upsertUserSubscriptionFromStripe(sb: any, row: Record<string, unknown>) {
  return sb.from('user_subscriptions').upsert(row, { onConflict: 'tenant_id,user_id' });
}

export function updateUserSubscriptionStatus(
  sb: any,
  args: { tenantId: string; userId: string; patch: Record<string, unknown> },
) {
  return sb
    .from('user_subscriptions')
    .update(args.patch)
    .eq('tenant_id', args.tenantId)
    .eq('user_id', args.userId);
}

// ---------------------------------------------------------------------------
// Admin: redemption codes management
// ---------------------------------------------------------------------------

export function fetchPlanByKey(sb: any, planKey: string) {
  return sb.from('subscription_plans').select('plan_key').eq('plan_key', planKey).maybeSingle();
}

export function insertRedemptionCodes(sb: any, rows: Array<Record<string, unknown>>) {
  return sb.from('redemption_codes').insert(rows);
}

export function listRedemptionCodes(
  sb: any,
  args: { campaign: string | null; offset: number; limit: number },
) {
  let query = sb
    .from('redemption_codes')
    .select('code, campaign, grants_plan, grant_duration_days, max_uses, uses_count, expires_at, is_active, created_at, created_by, metadata')
    .order('created_at', { ascending: false })
    .range(args.offset, args.offset + args.limit - 1);
  if (args.campaign) {
    query = query.eq('campaign', args.campaign);
  }
  return query;
}

export function updateRedemptionCodeActive(sb: any, args: { code: string; isActive: boolean }) {
  return sb
    .from('redemption_codes')
    .update({ is_active: args.isActive })
    .eq('code', args.code)
    .select('code, is_active')
    .maybeSingle();
}

// ---------------------------------------------------------------------------
// GET /admin/metrics
// ---------------------------------------------------------------------------

export function fetchActiveOrTrialingSubscriptions(sb: any) {
  return sb.from('user_subscriptions').select('plan_key, price_key, status').in('status', ['active', 'trialing', 'past_due']);
}

export function fetchActiveMonthlyPlanPrices(sb: any) {
  return sb.from('subscription_plan_prices').select('plan_key, billing_interval, price_cents').eq('billing_interval', 'month').eq('is_active', true);
}

export function fetchPaywallFunnelSince(sb: any, since: string) {
  return sb.from('paywall_events').select('action').gte('created_at', since);
}

export function fetchRedemptionsSince(sb: any, since: string) {
  return sb.from('redemption_redemptions').select('campaign, grant_value_cents').gte('redeemed_at', since);
}

export function fetchVoiceDegradeEventsSince(sb: any, since: string) {
  return sb
    .from('paywall_events')
    .select('id')
    .eq('action', 'degraded')
    .eq('feature_key', 'voice_live_minutes')
    .gte('created_at', since);
}

export function fetchTenantSettingsFeatureFlags(sb: any) {
  return sb.from('tenant_settings').select('feature_flags').maybeSingle();
}
