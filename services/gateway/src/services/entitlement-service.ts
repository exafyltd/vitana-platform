/**
 * VTID-03107 · Billing v1 — Entitlement service
 *
 * Single source of truth for "can this user use this feature right now?"
 *
 * Public API:
 *   checkEntitlement(userId, tenantId, feature, opts?) → CheckResult
 *   recordUsage(userId, tenantId, feature, amount=1)   → void
 *   consumeCredits(userId, tenantId, feature, units,
 *                  idempotencyKey, bucket?)            → ConsumeResult
 *   getUserPlan(userId, tenantId)                      → PlanSnapshot
 *   recordPaywallEvent(userId, tenantId, feature,
 *                      action, context?)               → void
 *
 * D36 hook
 *   Before returning a `paywall` or `hard_block` outcome, this service calls
 *   the D36 monetization-readiness engine. If D36 says NOT allow_paid
 *   (emotional vulnerability, recent rejection, cooldown), the outcome is
 *   downgraded to `deferred` and a paywall_events row with
 *   action='deferred_for_vulnerability' is written. Callers should treat
 *   `deferred` as "allow, but do not increment usage and do not show paywall."
 *
 * Cashflow guardrails
 *   - `allowed_burn_buckets` config on feature_entitlements controls which
 *     wallet buckets can fund overage. Voice/Rooms default to
 *     {purchased_credits} only. Cash_balance is NEVER spendable.
 *   - Reward credits cannot pay for voice or rooms by default (enforced via
 *     the seed config in migration 8).
 *
 * No new tables — only reads/writes existing v1 schema (subscription_plans,
 * user_subscriptions, feature_entitlements, feature_usage, paywall_events,
 * wallet_balances + RPCs fn_increment_feature_usage / fn_get_feature_usage /
 * fn_consume_credits).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../lib/supabase';
import { computeMonetizationContext } from './d36-financial-monetization-engine';

const VTID = 'VTID-03107';
const LOG_PREFIX = '[entitlement-service]';

// =============================================================================
// Types
// =============================================================================

export type BehaviorOnExceed =
  | 'paywall'
  | 'degrade'
  | 'hard_block'
  | 'soft_counter';

export type PaywallAction =
  | 'allow'           // quota available; caller proceeds normally
  | 'soft_counter'    // quota exhausted but behavior=soft_counter — caller proceeds and shows UI badge
  | 'paywall'         // quota exhausted, caller returns 402 with structured body
  | 'degrade'         // quota exhausted, caller switches to fallback (voice → Standard)
  | 'hard_block'      // quota exhausted, caller returns 402 without PAYG option
  | 'deferred';       // D36 protection — caller proceeds without increment, no UI paywall

export type WalletBucket = 'purchased_credits' | 'reward_credits' | 'cash_balance';

export interface EntitlementConfig {
  plan_key: string;
  feature_key: string;
  quota: number;              // monthly cap (always set)
  window_seconds: number;     // monthly window (default 30 days)
  window_5h_quota: number | null;   // optional rolling 5h cap (Free tier only)
  weekly_quota: number | null;      // optional rolling 7d cap (Free tier only)
  unit: 'count' | 'minutes' | 'bytes';
  behavior_on_exceed: BehaviorOnExceed;
  credit_cost_per_unit: number;
  allowed_burn_buckets: WalletBucket[];
}

/** Per-window snapshot exposed on /billing/me + paywall responses. */
export interface UsageWindow {
  name: 'window_5h' | 'weekly' | 'monthly';
  used: number;
  limit: number;
  reset_at: string | null;
}

export type BindingWindow = 'window_5h' | 'weekly' | 'monthly';

export interface PlanSnapshot {
  plan_key: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  trial_end: string | null;
  metadata: Record<string, unknown>;
}

export interface CheckResult {
  allowed: boolean;
  paywall_action: PaywallAction;
  feature: string;
  tier: string;
  // Legacy single-window fields kept for backwards compat with existing callers.
  // These mirror the BINDING window (most restrictive of the three).
  quota: number;
  used: number;
  remaining: number;
  reset_at: string | null;
  // Multi-window detail — surfaced to the UI so the user sees both
  // "5h resets in 2h 14m" and "Weekly resets Mon 1 Jun".
  windows: UsageWindow[];
  binding_window: BindingWindow;
  credit_cost_per_unit: number;
  user_credit_balance: number;
  allowed_burn_buckets: WalletBucket[];
  deferred_for_vulnerability: boolean;
}

export interface ConsumeResult {
  ok: boolean;
  error?: string;
  bucket?: string;
  bucket_balance?: number;
  duplicate?: boolean;
}

export interface CheckEntitlementOpts {
  amount?: number;          // requested amount (default 1) — for unit='minutes' could be a chunk size
  sessionId?: string;       // for D36 history tracking
  authToken?: string;       // user JWT (for D36 to read their personal monetization-signals)
  skipD36?: boolean;        // bypass D36 for admin/system flows (default false)
}

// =============================================================================
// Helpers
// =============================================================================

function client(): SupabaseClient {
  const sb = getSupabase();
  if (!sb) {
    throw new Error(`${LOG_PREFIX} Supabase service client unavailable — check SUPABASE_URL + SUPABASE_SERVICE_ROLE env`);
  }
  return sb;
}

function isAllowedPaywallAction(action: PaywallAction): boolean {
  return action === 'allow' || action === 'soft_counter' || action === 'deferred' || action === 'degrade';
}

/**
 * Default behavior when no feature_entitlements row exists. Fail closed to
 * paywall — we never silently allow an unknown feature.
 */
const DEFAULT_FAIL_CLOSED: BehaviorOnExceed = 'paywall';

// =============================================================================
// Public API — getUserPlan
// =============================================================================

/**
 * Read the user's current subscription state. Defaults to 'free' if no row.
 */
export async function getUserPlan(userId: string, tenantId: string): Promise<PlanSnapshot> {
  const sb = client();
  const { data, error } = await sb
    .from('user_subscriptions')
    .select('plan_key, status, current_period_end, cancel_at_period_end, trial_end, metadata')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error(`${LOG_PREFIX} getUserPlan error for user=${userId}: ${error.message}`);
    return {
      plan_key: 'free',
      status: 'free',
      current_period_end: null,
      cancel_at_period_end: false,
      trial_end: null,
      metadata: {},
    };
  }

  if (!data) {
    return {
      plan_key: 'free',
      status: 'free',
      current_period_end: null,
      cancel_at_period_end: false,
      trial_end: null,
      metadata: {},
    };
  }

  return {
    plan_key: data.plan_key,
    status: data.status,
    current_period_end: data.current_period_end,
    cancel_at_period_end: !!data.cancel_at_period_end,
    trial_end: data.trial_end,
    metadata: (data.metadata as Record<string, unknown>) || {},
  };
}

// =============================================================================
// Internal — readEntitlementConfig
// =============================================================================

async function readEntitlementConfig(
  planKey: string,
  feature: string
): Promise<EntitlementConfig | null> {
  const sb = client();
  const { data, error } = await sb
    .from('feature_entitlements')
    .select('plan_key, feature_key, quota, window_seconds, window_5h_quota, weekly_quota, unit, behavior_on_exceed, credit_cost_per_unit, allowed_burn_buckets')
    .eq('plan_key', planKey)
    .eq('feature_key', feature)
    .maybeSingle();

  if (error) {
    console.error(`${LOG_PREFIX} readEntitlementConfig(${planKey},${feature}) error: ${error.message}`);
    return null;
  }
  if (!data) return null;

  return {
    plan_key: data.plan_key,
    feature_key: data.feature_key,
    quota: data.quota,
    window_seconds: data.window_seconds,
    window_5h_quota: (data as { window_5h_quota?: number | null }).window_5h_quota ?? null,
    weekly_quota: (data as { weekly_quota?: number | null }).weekly_quota ?? null,
    unit: data.unit as 'count' | 'minutes' | 'bytes',
    behavior_on_exceed: data.behavior_on_exceed as BehaviorOnExceed,
    credit_cost_per_unit: data.credit_cost_per_unit,
    allowed_burn_buckets: (data.allowed_burn_buckets as WalletBucket[]) || ['purchased_credits'],
  };
}

// =============================================================================
// Internal — readUsageInCurrentWindow
// =============================================================================

interface UsageSnapshot {
  used: number;
  reset_at: string | null;
}

/**
 * Calendar-aligned bucket read (used for the monthly window). This is the
 * historical fn_get_feature_usage RPC — kept for backwards compat.
 */
async function readUsageInCurrentWindow(
  tenantId: string,
  userId: string,
  feature: string,
  windowSeconds: number
): Promise<UsageSnapshot> {
  const sb = client();
  const { data, error } = await sb.rpc('fn_get_feature_usage', {
    p_tenant_id: tenantId,
    p_user_id: userId,
    p_feature_key: feature,
    p_window_seconds: windowSeconds,
  });

  if (error || !data) {
    console.error(`${LOG_PREFIX} fn_get_feature_usage error: ${error?.message}`);
    return { used: 0, reset_at: null };
  }

  const result = data as Record<string, unknown>;
  return {
    used: (result.used as number) || 0,
    reset_at: (result.window_end as string) || null,
  };
}

/**
 * Sliding-window aggregation (used for 5h + weekly Free-tier rolling caps).
 * Shipped in migration 20260526100000. Returns SUM(used) over events in the
 * last `windowSeconds` plus the effective reset_at (= oldest event ages out).
 */
async function readUsageInSlidingWindow(
  tenantId: string,
  userId: string,
  feature: string,
  windowSeconds: number
): Promise<UsageSnapshot> {
  const sb = client();
  const { data, error } = await sb.rpc('fn_get_feature_usage_in_window', {
    p_tenant_id: tenantId,
    p_user_id: userId,
    p_feature_key: feature,
    p_window_seconds: windowSeconds,
  });

  if (error || !data) {
    console.error(`${LOG_PREFIX} fn_get_feature_usage_in_window error: ${error?.message}`);
    return { used: 0, reset_at: null };
  }

  const result = data as Record<string, unknown>;
  return {
    used: (result.used as number) || 0,
    reset_at: (result.reset_at as string) || null,
  };
}

const SECONDS_PER_5H = 5 * 60 * 60;
const SECONDS_PER_WEEK = 7 * 24 * 60 * 60;

/**
 * Build the per-feature usage windows array. Includes only the windows that
 * are configured (window_5h/weekly are optional; monthly is always present).
 */
async function readAllWindows(
  tenantId: string,
  userId: string,
  config: EntitlementConfig
): Promise<UsageWindow[]> {
  const windows: UsageWindow[] = [];

  if (config.window_5h_quota !== null && config.window_5h_quota !== undefined) {
    const u = await readUsageInSlidingWindow(tenantId, userId, config.feature_key, SECONDS_PER_5H);
    windows.push({
      name: 'window_5h',
      used: u.used,
      limit: config.window_5h_quota,
      reset_at: u.reset_at,
    });
  }

  if (config.weekly_quota !== null && config.weekly_quota !== undefined) {
    const u = await readUsageInSlidingWindow(tenantId, userId, config.feature_key, SECONDS_PER_WEEK);
    windows.push({
      name: 'weekly',
      used: u.used,
      limit: config.weekly_quota,
      reset_at: u.reset_at,
    });
  }

  const monthly = await readUsageInCurrentWindow(tenantId, userId, config.feature_key, config.window_seconds);
  windows.push({
    name: 'monthly',
    used: monthly.used,
    limit: config.quota,
    reset_at: monthly.reset_at,
  });

  return windows;
}

/**
 * Pick the binding window: the one with the LEAST remaining (or already
 * over-quota). Ties broken by shortest reset time (window_5h before weekly
 * before monthly).
 */
function pickBindingWindow(windows: UsageWindow[]): { window: UsageWindow; index: number } {
  let bestIdx = 0;
  let bestRemaining = windows[0].limit - windows[0].used;
  for (let i = 1; i < windows.length; i++) {
    const remaining = windows[i].limit - windows[i].used;
    if (remaining < bestRemaining) {
      bestRemaining = remaining;
      bestIdx = i;
    }
  }
  return { window: windows[bestIdx], index: bestIdx };
}

// =============================================================================
// Internal — readWalletBuckets
// =============================================================================

interface WalletBucketsSnapshot {
  purchased_credits: number;
  reward_credits: number;
  cash_balance: number;
}

async function readWalletBuckets(
  tenantId: string,
  userId: string
): Promise<WalletBucketsSnapshot> {
  const sb = client();
  const { data, error } = await sb
    .from('wallet_balances')
    .select('purchased_credits, reward_credits, cash_balance')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) {
    return { purchased_credits: 0, reward_credits: 0, cash_balance: 0 };
  }
  return {
    purchased_credits: data.purchased_credits || 0,
    reward_credits: data.reward_credits || 0,
    cash_balance: data.cash_balance || 0,
  };
}

/**
 * Returns the credit balance available to fund overage for a given feature,
 * respecting `allowed_burn_buckets` config.
 */
function bucketsToBalance(
  buckets: WalletBucketsSnapshot,
  allowed: WalletBucket[]
): number {
  return allowed.reduce((sum, b) => sum + (buckets[b] || 0), 0);
}

// =============================================================================
// Public API — checkEntitlement
// =============================================================================

export async function checkEntitlement(
  userId: string,
  tenantId: string,
  feature: string,
  opts: CheckEntitlementOpts = {}
): Promise<CheckResult> {
  const amount = Math.max(1, opts.amount ?? 1);

  // 1. Resolve plan
  const plan = await getUserPlan(userId, tenantId);
  const planKey = plan.plan_key || 'free';

  // 2. Resolve entitlement config (fail closed if missing)
  const config = await readEntitlementConfig(planKey, feature);
  if (!config) {
    console.warn(`${LOG_PREFIX} No entitlement config for (${planKey}, ${feature}) — failing closed to paywall`);
    return {
      allowed: false,
      paywall_action: DEFAULT_FAIL_CLOSED,
      feature,
      tier: planKey,
      quota: 0,
      used: 0,
      remaining: 0,
      reset_at: null,
      windows: [],
      binding_window: 'monthly',
      credit_cost_per_unit: 0,
      user_credit_balance: 0,
      allowed_burn_buckets: ['purchased_credits'],
      deferred_for_vulnerability: false,
    };
  }

  // 3. Read usage in every configured window (5h / weekly / monthly).
  //    Paid tiers only have monthly; Free has all three.
  const windows = await readAllWindows(tenantId, userId, config);
  const binding = pickBindingWindow(windows);
  const remaining = binding.window.limit - binding.window.used;

  // 4. Read wallet buckets relevant to this feature's allowed_burn_buckets
  const buckets = await readWalletBuckets(tenantId, userId);
  const userCreditBalance = bucketsToBalance(buckets, config.allowed_burn_buckets);

  // 5. Decide outcome
  // If the request fits within the BINDING window's remaining quota → allow
  if (remaining >= amount) {
    return {
      allowed: true,
      paywall_action: 'allow',
      feature,
      tier: planKey,
      quota: binding.window.limit,
      used: binding.window.used,
      remaining,
      reset_at: binding.window.reset_at,
      windows,
      binding_window: binding.window.name,
      credit_cost_per_unit: config.credit_cost_per_unit,
      user_credit_balance: userCreditBalance,
      allowed_burn_buckets: config.allowed_burn_buckets,
      deferred_for_vulnerability: false,
    };
  }

  // Quota exhausted. Translate behavior_on_exceed to a paywall_action.
  let action: PaywallAction;
  switch (config.behavior_on_exceed) {
    case 'soft_counter':
      action = 'soft_counter';
      break;
    case 'degrade':
      action = 'degrade';
      break;
    case 'hard_block':
      action = 'hard_block';
      break;
    case 'paywall':
    default:
      action = 'paywall';
      break;
  }

  // 6. D36 deferral hook — only for outcomes that would BLOCK the user
  // (hard_block, paywall). Degrade is graceful and doesn't need deferral.
  // soft_counter doesn't block, no deferral needed.
  let deferredForVulnerability = false;
  if (!opts.skipD36 && (action === 'paywall' || action === 'hard_block')) {
    try {
      const d36 = await computeMonetizationContext(undefined, opts.sessionId, opts.authToken);
      if (d36.ok && d36.envelope && !d36.envelope.allow_paid) {
        deferredForVulnerability = true;
        action = 'deferred';
        // Audit: write a paywall_events row noting the deferral
        await recordPaywallEvent(userId, tenantId, feature, 'deferred_for_vulnerability', {
          original_action: config.behavior_on_exceed,
          reason: d36.envelope.reason || 'D36 envelope.allow_paid=false',
          tags: d36.envelope.tags || [],
          plan: planKey,
        });
      }
    } catch (err) {
      // D36 failure should not BLOCK monetization (fail open to the configured behavior)
      console.error(`${LOG_PREFIX} D36 check failed for user=${userId} feature=${feature}: ${err}`);
    }
  }

  return {
    allowed: isAllowedPaywallAction(action),
    paywall_action: action,
    feature,
    tier: planKey,
    quota: binding.window.limit,
    used: binding.window.used,
    remaining: Math.max(0, remaining),
    reset_at: binding.window.reset_at,
    windows,
    binding_window: binding.window.name,
    credit_cost_per_unit: config.credit_cost_per_unit,
    user_credit_balance: userCreditBalance,
    allowed_burn_buckets: config.allowed_burn_buckets,
    deferred_for_vulnerability: deferredForVulnerability,
  };
}

// =============================================================================
// Public API — recordUsage
// =============================================================================

/**
 * Atomic increment of the user's feature_usage counter. Call AFTER the user
 * action has been allowed.
 *
 * Writes a per-minute event row so sliding-window aggregation (5h, weekly)
 * works correctly. Same-minute increments fold into the same row via the
 * existing ON CONFLICT (user_id, feature_key, window_start).
 *
 * Sliding aggregation reads via fn_get_feature_usage_in_window (SUM over
 * recent minute rows). Monthly aggregation (calendar-aligned) is computed
 * client-side over the same minute rows by passing 30d to the same RPC, OR
 * the legacy fn_get_feature_usage if the caller wants epoch-aligned buckets.
 *
 * @returns the new `used` value after increment in the minute-bucket, or
 *          null on error. (Callers usually care about the aggregate, not
 *          the per-minute total.)
 */
export async function recordUsage(
  userId: string,
  tenantId: string,
  feature: string,
  amount: number = 1
): Promise<number | null> {
  const sb = client();
  // Always write at minute granularity so sliding-window SUM works.
  const { data, error } = await sb.rpc('fn_increment_feature_usage', {
    p_tenant_id: tenantId,
    p_user_id: userId,
    p_feature_key: feature,
    p_amount: amount,
    p_window_seconds: 60,
  });

  if (error || !data) {
    console.error(`${LOG_PREFIX} fn_increment_feature_usage error: ${error?.message}`);
    return null;
  }
  const result = data as Record<string, unknown>;
  return (result.used as number) ?? null;
}

// =============================================================================
// Public API — consumeCredits
// =============================================================================

/**
 * Debit the user's wallet to fund overage for a feature. Uses the existing
 * fn_consume_credits RPC which maps bucket → wallet_transactions.type and
 * lets the §M trigger route correctly. Idempotent on idempotencyKey.
 *
 * When `bucket` is omitted, picks the first allowed bucket from the feature's
 * config (rewards first if allowed, else purchased) to drain lower-utility
 * credits first.
 */
export async function consumeCredits(
  userId: string,
  tenantId: string,
  feature: string,
  units: number,
  idempotencyKey: string,
  preferredBucket?: WalletBucket
): Promise<ConsumeResult> {
  if (units <= 0) {
    return { ok: false, error: 'INVALID_AMOUNT' };
  }

  // Resolve the feature's allowed buckets + cost-per-unit
  const planSnapshot = await getUserPlan(userId, tenantId);
  const config = await readEntitlementConfig(planSnapshot.plan_key, feature);
  if (!config || config.credit_cost_per_unit <= 0) {
    return { ok: false, error: 'PAYG_NOT_AVAILABLE_FOR_FEATURE' };
  }

  const creditsToDebit = units * config.credit_cost_per_unit;
  const buckets = await readWalletBuckets(tenantId, userId);

  // Pick bucket: preferred if explicitly given AND allowed, else "rewards
  // first if allowed and has sufficient balance, else purchased"
  let bucket: WalletBucket;
  if (preferredBucket && config.allowed_burn_buckets.includes(preferredBucket)) {
    bucket = preferredBucket;
  } else if (
    config.allowed_burn_buckets.includes('reward_credits') &&
    buckets.reward_credits >= creditsToDebit
  ) {
    bucket = 'reward_credits';
  } else {
    bucket = 'purchased_credits';
  }

  const sb = client();
  const { data, error } = await sb.rpc('fn_consume_credits', {
    p_tenant_id: tenantId,
    p_user_id: userId,
    p_credits: creditsToDebit,
    p_bucket: bucket,
    p_feature_key: feature,
    p_idempotency_key: idempotencyKey,
  });

  if (error || !data) {
    console.error(`${LOG_PREFIX} fn_consume_credits error: ${error?.message}`);
    return { ok: false, error: 'INTERNAL_ERROR' };
  }

  const result = data as Record<string, unknown>;
  if ((result.ok as boolean) === true) {
    // Audit
    await recordPaywallEvent(userId, tenantId, feature, 'credit_paid', {
      bucket,
      credits_debited: creditsToDebit,
      units,
      idempotency_key: idempotencyKey,
      duplicate: result.duplicate === true,
    });
    return {
      ok: true,
      bucket: result.bucket as string,
      bucket_balance: result.bucket_balance as number,
      duplicate: result.duplicate === true,
    };
  }

  return {
    ok: false,
    error: (result.error as string) || 'UNKNOWN',
    bucket: result.bucket as string,
    bucket_balance: result.bucket_balance as number,
  };
}

// =============================================================================
// Public API — recordPaywallEvent
// =============================================================================

export type PaywallEventAction =
  | 'shown'
  | 'upgraded'
  | 'rejected'
  | 'credit_paid'
  | 'deferred_for_vulnerability'
  | 'degraded'
  | 'redeemed'
  | 'soft_counter_reached';

export async function recordPaywallEvent(
  userId: string,
  tenantId: string,
  feature: string,
  action: PaywallEventAction,
  context: Record<string, unknown> = {}
): Promise<void> {
  const sb = client();
  const { error } = await sb.from('paywall_events').insert({
    tenant_id: tenantId,
    user_id: userId,
    feature_key: feature,
    action,
    context,
  });
  if (error) {
    console.error(`${LOG_PREFIX} recordPaywallEvent(${action}) error: ${error.message}`);
  }
}

// =============================================================================
// VTID marker for grep
// =============================================================================
export const _VTID = VTID;
