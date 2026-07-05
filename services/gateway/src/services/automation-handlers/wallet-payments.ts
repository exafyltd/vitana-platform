/**
 * Payments, Wallet & VTN Handlers — AP-0700 series
 *
 * VTID: VTID-01250
 * Automations for Stripe lifecycle, wallet credits, creator payouts.
 */

import { AutomationContext, REWARD_TABLE } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// ── AP-0701: Payment Failure Detection & Retry ──────────────
async function runPaymentFailureRetry(ctx: AutomationContext) {
  ctx.log('Checking for failed payments (delegates to existing heartbeat)');
  // Existing OpenClaw bridge handles this; wrapper for tracking
  return { usersAffected: 0, actionsTaken: 0 };
}

// ── AP-0702: Subscription Created Audit ─────────────────────
async function runSubscriptionAudit(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  ctx.log(`Subscription audit: ${payload?.subscription_id}`);
  await ctx.emitEvent('autopilot.wallet.subscription_audited', payload || {});
  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0705: Payment Method Update Reminder ─────────────────
async function runPaymentMethodReminder(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  ctx.notify(userId, 'orb_proactive_message', {
    title: 'Update Your Payment Method',
    body: 'Your recent payment couldn\'t be processed. Please update your payment details.',
    data: { url: '/wallet/payment-methods' },
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0706: Creator Stripe Connect Onboarding ──────────────
// app_users' primary key is user_id, not id.
async function runCreatorStripeOnboarding(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Check if user already has Stripe account
  const { data: user } = await supabase
    .from('app_users')
    .select('stripe_account_id, stripe_charges_enabled')
    .eq('user_id', userId)
    .maybeSingle();

  if (user?.stripe_charges_enabled) {
    ctx.log('Creator already has Stripe Connect enabled');
    return { usersAffected: 0, actionsTaken: 0 };
  }

  if (!user?.stripe_account_id) {
    ctx.notify(userId, 'orb_proactive_message', {
      title: 'Start Receiving Payments',
      body: 'To receive payments for your services, complete your payout setup — takes 2 minutes.',
      data: { url: '/business/payout-setup' },
    });
  }

  await ctx.emitEvent('autopilot.wallet.creator_onboard_prompted', { user_id: userId });
  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0707: Creator Payout Monitoring ──────────────────────
async function runCreatorPayoutMonitor(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, payout_status, amount } = payload || {};
  if (!user_id) return { usersAffected: 0, actionsTaken: 0 };

  if (payout_status === 'paid') {
    ctx.notify(user_id, 'orb_proactive_message', {
      title: 'Payout Received!',
      body: `Your payout of ${amount || 'your earnings'} has been processed.`,
      data: { url: '/business/earnings' },
    });
  } else if (payout_status === 'failed') {
    ctx.notify(user_id, 'orb_proactive_message', {
      title: 'Payout Issue',
      body: 'Your payout couldn\'t be processed. Please check your banking details.',
      data: { url: '/business/payout-setup' },
    });
  }

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0708: Wallet Credit Rewards for Engagement ───────────
// credit_wallet() RPC (and any backing ledger with its own dedup-by-
// source_event_id) doesn't exist live. increment_wallet_balance() is the
// real RPC (writes to user_wallets — the same table already used by
// AP-0101/AP-0405/AP-1301's welcome-bonus flow this session), but it has no
// idempotency of its own. Rather than write to wallet_credits (explicitly
// called out as a "ghost commerce table" in universal-cart.ts, VTID-03213 —
// not a table to build new reliance on), dedup is self-guarded the same way
// AP-0411/AP-0605 do: check user_notifications for a prior reward record
// carrying this exact source_event_id before crediting again.
async function runWalletCreditReward(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, reward_type, event_id } = payload || {};
  if (!user_id || !reward_type) return { usersAffected: 0, actionsTaken: 0 };

  const rewardConfig = REWARD_TABLE[reward_type];
  if (!rewardConfig) {
    ctx.log(`Unknown reward type: ${reward_type}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const { supabase } = ctx;
  const sourceEventId = event_id || `${reward_type}_${user_id}_${Date.now()}`;

  if (event_id) {
    const { data: existingReward } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', user_id)
      .contains('data', { automation_id: 'AP-0708', source_event_id: sourceEventId })
      .limit(1);
    if (existingReward && existingReward.length > 0) {
      ctx.log(`Duplicate reward blocked: ${reward_type} for ${user_id}`);
      return { usersAffected: 0, actionsTaken: 0 };
    }
  }

  const { data: newBalance, error } = await supabase.rpc('increment_wallet_balance', {
    p_user_id: user_id,
    p_currency_type: 'CREDITS',
    p_amount: rewardConfig.amount,
  });

  if (!error) {
    ctx.notify(user_id, 'orb_proactive_message', {
      title: `+${rewardConfig.amount} Credits!`,
      body: `${rewardConfig.description}. Your balance: ${newBalance} credits.`,
      data: {
        url: '/wallet', amount: String(rewardConfig.amount), balance: String(newBalance),
        automation_id: 'AP-0708', source_event_id: sourceEventId,
      },
    });

    await ctx.emitEvent('autopilot.wallet.credits_awarded', {
      user_id, reward_type, amount: rewardConfig.amount, balance: newBalance,
    });

    return { usersAffected: 1, actionsTaken: 1 };
  }

  ctx.log(`Wallet credit failed for ${user_id}: ${error.message}`);
  return { usersAffected: 0, actionsTaken: 0 };
}

// ── AP-0710: Monetization Readiness Scoring ─────────────────
// KNOWN GAP: monetization_signals and d28_emotional_signals were never
// deployed (no substitute table exists) — both queries always no-op
// (error, empty data), so this always returns the 50% baseline / not
// vulnerable. Left as-is rather than inventing a replacement schema.
async function runMonetizationReadinessCheck(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Check recent monetization signals
  const thirtyDays = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: signals } = await supabase
    .from('monetization_signals')
    .select('signal_type, indicator, weight')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .gte('detected_at', thirtyDays);

  // Simple readiness score calculation
  let readiness = 50; // baseline
  for (const signal of signals || []) {
    if (signal.indicator === 'positive') readiness += (signal.weight || 10) * 0.5;
    if (signal.indicator === 'negative') readiness -= (signal.weight || 10) * 0.5;
  }
  readiness = Math.max(0, Math.min(100, readiness));

  // Check for vulnerability signals
  const { data: emotionalSignals } = await supabase
    .from('d28_emotional_signals')
    .select('signal_type')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .in('signal_type', ['emotional_vulnerability', 'distress', 'overwhelmed'])
    .limit(1);

  const isVulnerable = (emotionalSignals?.length || 0) > 0;

  ctx.log(`Monetization readiness for ${userId}: ${readiness}% (vulnerable: ${isVulnerable})`);

  // Return result via metadata (caller checks this)
  ctx.run.metadata = {
    ...ctx.run.metadata,
    readiness_score: readiness,
    is_vulnerable: isVulnerable,
    allow_monetization: readiness >= 60 && !isVulnerable,
  };

  return { usersAffected: 1, actionsTaken: 0 };
}

// ── AP-0711: Weekly Earnings Report for Creators ────────────
// app_users' primary key is user_id, not id. user_offers_memory (VTID-01092)
// was never deployed — service_payments (payee_vitana_id TEXT, joins
// app_users.vitana_id; same pattern already used in live-rooms-commerce.ts
// and business-opportunity.ts) is the real transaction-count source.
async function runCreatorWeeklyEarnings(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Find all creators (users with stripe_charges_enabled)
  const { data: creators } = await supabase
    .from('app_users')
    .select('user_id, display_name, vitana_id')
    .eq('stripe_charges_enabled', true);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const creator of creators || []) {
    let txCount = 0;
    if (creator.vitana_id) {
      const { count } = await supabase
        .from('service_payments')
        .select('id', { count: 'exact', head: true })
        .eq('payee_vitana_id', creator.vitana_id)
        .in('state', ['captured', 'released'])
        .gte('created_at', sevenDaysAgo);
      txCount = count || 0;
    }

    ctx.notify(creator.user_id, 'orb_proactive_message', {
      title: 'Your Weekly Earnings',
      body: `${txCount} transactions this week. Check your Business Hub for details.`,
      data: { url: '/business/earnings' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0704: Subscription Expiry Warning ────────────────────
// user_subscriptions (tenant_id, user_id, status, current_period_end,
// cancel_at_period_end) is the live table. Warns users whose subscription
// is set to lapse (cancel_at_period_end=true) within 3 days.
const EXPIRY_WARNING_WINDOW_DAYS = 3;
const EXPIRY_WARNING_COOLDOWN_DAYS = 7;

async function runSubscriptionExpiryWarning(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const windowEnd = new Date(now.getTime() + EXPIRY_WARNING_WINDOW_DAYS * 86_400_000);

  const { data: expiring } = await supabase
    .from('user_subscriptions')
    .select('user_id, plan_key, current_period_end')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .eq('cancel_at_period_end', true)
    .gte('current_period_end', now.toISOString())
    .lte('current_period_end', windowEnd.toISOString())
    .limit(500);

  const cooldownCutoff = new Date(now.getTime() - EXPIRY_WARNING_COOLDOWN_DAYS * 86_400_000).toISOString();

  for (const sub of expiring || []) {
    const { data: recentWarning } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', sub.user_id)
      .contains('data', { automation_id: 'AP-0704' })
      .gte('created_at', cooldownCutoff)
      .limit(1);
    if (recentWarning && recentWarning.length > 0) continue;

    const daysLeft = Math.max(1, Math.ceil((new Date(sub.current_period_end).getTime() - now.getTime()) / 86_400_000));

    ctx.notify(sub.user_id, 'orb_proactive_message', {
      title: 'Your Subscription Is Ending Soon',
      body: `Your ${sub.plan_key || 'plan'} subscription ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Renew to keep your benefits.`,
      data: { url: '/wallet/subscription', automation_id: 'AP-0704' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0712: Spending Insights for Users ────────────────────
// wallet_transactions (from_user_id, to_currency dropped — from_currency/
// amount/status; no tenant_id column) is the live VTN exchange ledger.
// Summarizes the prior calendar month's completed outgoing spend per user.
const SPENDING_INSIGHTS_MAX_USERS_PER_RUN = 1000;

async function runSpendingInsights(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 1);

  const users = (await ctx.queryTargetUsers()).slice(0, SPENDING_INSIGHTS_MAX_USERS_PER_RUN);

  for (const { user_id } of users) {
    const { data: txs } = await supabase
      .from('wallet_transactions')
      .select('amount, from_currency')
      .eq('from_user_id', user_id)
      .eq('status', 'completed')
      .gte('created_at', monthStart.toISOString())
      .lt('created_at', monthEnd.toISOString());

    if (!txs?.length) continue;

    const totalsByCurrency = new Map<string, number>();
    for (const tx of txs) {
      const currency = tx.from_currency || 'CREDITS';
      totalsByCurrency.set(currency, (totalsByCurrency.get(currency) || 0) + Number(tx.amount || 0));
    }

    const summary = [...totalsByCurrency.entries()].map(([currency, total]) => `${Math.round(total)} ${currency}`).join(', ');

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'Your Monthly Spending Summary',
      body: `You spent ${summary} last month across ${txs.length} transaction${txs.length === 1 ? '' : 's'}.`,
      data: { url: '/wallet', automation_id: 'AP-0712' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

export function registerWalletPaymentsHandlers(): void {
  registerHandler('runPaymentFailureRetry', runPaymentFailureRetry);
  registerHandler('runSubscriptionAudit', runSubscriptionAudit);
  registerHandler('runPaymentMethodReminder', runPaymentMethodReminder);
  registerHandler('runSubscriptionExpiryWarning', runSubscriptionExpiryWarning);
  registerHandler('runSpendingInsights', runSpendingInsights);
  registerHandler('runCreatorStripeOnboarding', runCreatorStripeOnboarding);
  registerHandler('runCreatorPayoutMonitor', runCreatorPayoutMonitor);
  registerHandler('runWalletCreditReward', runWalletCreditReward);
  registerHandler('runMonetizationReadinessCheck', runMonetizationReadinessCheck);
  registerHandler('runCreatorWeeklyEarnings', runCreatorWeeklyEarnings);
}
