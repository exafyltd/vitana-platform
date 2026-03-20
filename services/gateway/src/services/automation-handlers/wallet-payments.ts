/**
 * Payments, Wallet & VTN Handlers — AP-0700 series
 *
 * VTID: VTID-01250
 * Automations for Stripe lifecycle, wallet credits, creator payouts.
 */

import { AutomationContext, REWARD_TABLE, CreditWalletResult } from '../../types/automations';
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
async function runCreatorStripeOnboarding(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Check if user already has Stripe account
  const { data: user } = await supabase
    .from('app_users')
    .select('stripe_account_id, stripe_charges_enabled')
    .eq('id', userId)
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
async function runWalletCreditReward(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, reward_type, event_id } = payload || {};
  if (!user_id || !reward_type) return { usersAffected: 0, actionsTaken: 0 };

  const rewardConfig = REWARD_TABLE[reward_type];
  if (!rewardConfig) {
    ctx.log(`Unknown reward type: ${reward_type}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const { supabase, tenantId } = ctx;
  const sourceEventId = event_id || `${reward_type}_${user_id}_${Date.now()}`;

  const { data } = await supabase.rpc('credit_wallet', {
    p_tenant_id: tenantId,
    p_user_id: user_id,
    p_amount: rewardConfig.amount,
    p_type: 'reward',
    p_source: 'AP-0708',
    p_source_event_id: sourceEventId,
    p_description: rewardConfig.description,
  });

  const result = data as CreditWalletResult;

  if (result?.duplicate) {
    ctx.log(`Duplicate reward blocked: ${reward_type} for ${user_id}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }

  if (result?.ok) {
    ctx.notify(user_id, 'orb_proactive_message', {
      title: `+${rewardConfig.amount} Credits!`,
      body: `${rewardConfig.description}. Your balance: ${result.balance} credits.`,
      data: { url: '/wallet', amount: String(rewardConfig.amount), balance: String(result.balance) },
    });

    await ctx.emitEvent('autopilot.wallet.credits_awarded', {
      user_id, reward_type, amount: rewardConfig.amount, balance: result.balance,
    });
  }

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0710: Monetization Readiness Scoring ─────────────────
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
async function runCreatorWeeklyEarnings(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Find all creators (users with stripe_charges_enabled)
  const { data: creators } = await supabase
    .from('app_users')
    .select('id, display_name')
    .eq('stripe_charges_enabled', true);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const creator of creators || []) {
    // Count services used this week
    const { count: txCount } = await supabase
      .from('user_offers_memory')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('target_id', creator.id)
      .eq('state', 'used')
      .gte('updated_at', sevenDaysAgo);

    ctx.notify(creator.id, 'orb_proactive_message', {
      title: 'Your Weekly Earnings',
      body: `${txCount || 0} transactions this week. Check your Business Hub for details.`,
      data: { url: '/business/earnings' },
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
  registerHandler('runCreatorStripeOnboarding', runCreatorStripeOnboarding);
  registerHandler('runCreatorPayoutMonitor', runCreatorPayoutMonitor);
  registerHandler('runWalletCreditReward', runWalletCreditReward);
  registerHandler('runMonetizationReadinessCheck', runMonetizationReadinessCheck);
  registerHandler('runCreatorWeeklyEarnings', runCreatorWeeklyEarnings);
}
