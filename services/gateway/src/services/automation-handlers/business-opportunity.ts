/**
 * Business Opportunity Handlers — AP-1500 series
 *
 * VTID: VTID-01250
 * Automations helping creators find gaps, demand, and revenue opportunities.
 * Real schema: live_rooms has category/topic_keys (not products_catalog);
 * global_community_groups has category+member_count; service_payments has
 * payee_vitana_id (TEXT, joined via app_users.vitana_id); app_users' PK is
 * user_id.
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// ── AP-1501: Marketplace Gap Detection ───────────────────────
// Compares community-group interest (member_count by category) against
// creator supply (live_rooms hosted per category in the last 30 days) to
// find high-demand, low-supply categories.
const GAP_SUPPLY_WINDOW_DAYS = 30;
const GAP_MIN_GROUP_MEMBERS = 10;

async function runMarketplaceGapDetection(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;

  const { data: groups } = await supabase
    .from('global_community_groups')
    .select('category, member_count')
    .not('category', 'is', null)
    .limit(500);

  const demandByCategory = new Map<string, number>();
  for (const g of groups || []) {
    const cat = (g.category || '').toLowerCase();
    demandByCategory.set(cat, (demandByCategory.get(cat) || 0) + (g.member_count || 0));
  }

  const since = new Date(Date.now() - GAP_SUPPLY_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: rooms } = await supabase
    .from('live_rooms')
    .select('category')
    .eq('tenant_id', tenantId)
    .gte('created_at', since)
    .limit(1000);

  const supplyByCategory = new Map<string, number>();
  for (const r of rooms || []) {
    const cat = (r.category || '').toLowerCase();
    supplyByCategory.set(cat, (supplyByCategory.get(cat) || 0) + 1);
  }

  let gapCategory: string | null = null;
  let gapDemand = 0;
  for (const [cat, demand] of demandByCategory) {
    if (demand < GAP_MIN_GROUP_MEMBERS) continue;
    const supply = supplyByCategory.get(cat) || 0;
    if (supply === 0 && demand > gapDemand) { gapCategory = cat; gapDemand = demand; }
  }

  if (!gapCategory) return { usersAffected: 0, actionsTaken: 0 };

  const creators = await ctx.queryTargetUsers();
  let usersAffected = 0;
  let actionsTaken = 0;
  for (const { user_id } of creators) {
    ctx.notify(user_id, 'orb_suggestion', {
      title: 'Untapped Opportunity Detected',
      body: `${gapDemand} community members are interested in "${gapCategory}" but no one is hosting Live Rooms there yet.`,
      data: { url: '/live/create', category: gapCategory },
    });
    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.business.gap_detected', { category: gapCategory, demand: gapDemand });
  return { usersAffected, actionsTaken };
}

// ── AP-1502: Revenue Opportunity Alert ──────────────────────
// Heartbeat scan comparing a creator's trailing-7-day service_payments
// revenue against the prior 7 days; alerts on significant swings either way.
const REVENUE_ALERT_MIN_ABS_CHANGE_PERCENT = 25;

async function runRevenueOpportunityAlert(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const { data: creators } = await supabase
    .from('app_users')
    .select('user_id, vitana_id')
    .eq('stripe_charges_enabled', true)
    .limit(500);

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86_400_000).toISOString();

  for (const creator of creators || []) {
    if (!creator.vitana_id) continue;

    const { data: recentPayments } = await supabase
      .from('service_payments')
      .select('amount_cents')
      .eq('payee_vitana_id', creator.vitana_id)
      .in('state', ['captured', 'released'])
      .gte('created_at', sevenDaysAgo);
    const { data: priorPayments } = await supabase
      .from('service_payments')
      .select('amount_cents')
      .eq('payee_vitana_id', creator.vitana_id)
      .in('state', ['captured', 'released'])
      .gte('created_at', fourteenDaysAgo)
      .lt('created_at', sevenDaysAgo);

    const recentTotal = (recentPayments || []).reduce((sum: number, p: any) => sum + (p.amount_cents || 0), 0);
    const priorTotal = (priorPayments || []).reduce((sum: number, p: any) => sum + (p.amount_cents || 0), 0);
    if (priorTotal === 0) continue;

    const changePercent = ((recentTotal - priorTotal) / priorTotal) * 100;
    if (Math.abs(changePercent) < REVENUE_ALERT_MIN_ABS_CHANGE_PERCENT) continue;

    const isUp = changePercent > 0;
    ctx.notify(creator.user_id, 'orb_proactive_message', {
      title: isUp ? 'Your Earnings Are Trending Up!' : 'Your Earnings Dipped This Week',
      body: isUp
        ? `Revenue is up ${Math.round(changePercent)}% vs last week — keep the momentum going.`
        : `Revenue is down ${Math.round(Math.abs(changePercent))}% vs last week. Check your Business Hub for tips.`,
      data: { url: '/business/earnings' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1503: Service Demand Matching ─────────────────────────
// Personalized counterpart to AP-1501: only notifies creators who don't yet
// host in a high-demand category (vs. AP-1501's broad weekly announcement).
const DEMAND_MIN_GROUP_MEMBERS = 10;

async function runServiceDemandMatching(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;

  const { data: groups } = await supabase
    .from('global_community_groups')
    .select('category, member_count')
    .not('category', 'is', null)
    .order('member_count', { ascending: false })
    .limit(20);

  const topCategories = (groups || [])
    .filter((g: any) => (g.member_count || 0) >= DEMAND_MIN_GROUP_MEMBERS)
    .map((g: any) => (g.category || '').toLowerCase());
  if (!topCategories.length) return { usersAffected: 0, actionsTaken: 0 };

  const { data: creators } = await supabase
    .from('app_users')
    .select('user_id')
    .eq('stripe_charges_enabled', true)
    .limit(500);

  let usersAffected = 0;
  let actionsTaken = 0;

  for (const creator of creators || []) {
    const { data: ownRooms } = await supabase
      .from('live_rooms')
      .select('category')
      .eq('tenant_id', tenantId)
      .eq('host_user_id', creator.user_id)
      .limit(20);
    const ownCategories = new Set((ownRooms || []).map((r: any) => (r.category || '').toLowerCase()));

    const unservedDemand = topCategories.find((cat: string) => !ownCategories.has(cat));
    if (!unservedDemand) continue;

    ctx.notify(creator.user_id, 'orb_suggestion', {
      title: 'A Category You Haven\'t Tapped Into',
      body: `There's active demand for "${unservedDemand}" in the community — consider offering a service there.`,
      data: { url: '/live/create', category: unservedDemand },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1504: Business Setup Coach ────────────────────────────
// Shares the 'user.business.started' topic with AP-1106 (business-marketplace.ts) —
// neither is dispatched anywhere yet (frontend doesn't call dispatchEvent for
// this transition), but the handler is real and will fire once that gap is
// closed. Checks Stripe onboarding + first listing as setup milestones.
async function runBusinessSetupCoach(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: user } = await supabase
    .from('app_users')
    .select('stripe_charges_enabled')
    .eq('user_id', userId)
    .maybeSingle();

  if (!user?.stripe_charges_enabled) {
    ctx.notify(userId, 'orb_proactive_message', {
      title: 'Step 1: Set Up Payments',
      body: 'Complete your payout setup so you can start getting paid for your services.',
      data: { url: '/business/payout-setup' },
    });
    return { usersAffected: 1, actionsTaken: 1 };
  }

  const { count: roomCount } = await supabase
    .from('live_rooms')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('host_user_id', userId);

  if (!roomCount) {
    ctx.notify(userId, 'orb_proactive_message', {
      title: 'Step 2: Create Your First Listing',
      body: 'Payments are set up — now host your first Live Room to start attracting clients.',
      data: { url: '/live/create' },
    });
    return { usersAffected: 1, actionsTaken: 1 };
  }

  return { usersAffected: 0, actionsTaken: 0 };
}

// ── AP-1505: Income Growth Tips ───────────────────────────────
// Weekly cron, distinct from AP-1502 (reactive revenue-swing alert): always
// sends one prescriptive coaching tip based on the creator's current stats.
async function runIncomeGrowthTips(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const { data: creators } = await supabase
    .from('app_users')
    .select('user_id')
    .eq('stripe_charges_enabled', true)
    .limit(500);

  for (const creator of creators || []) {
    const { count: roomCount } = await supabase
      .from('live_rooms')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('host_user_id', creator.user_id);

    let tip: string;
    if (!roomCount) {
      tip = 'Host your first Live Room this week to start building an audience.';
    } else if (roomCount < 3) {
      tip = 'Consistency builds an audience — try scheduling a recurring weekly session.';
    } else {
      tip = 'You\'ve got a solid track record — consider cross-promoting your Live Rooms in relevant Community Groups.';
    }

    ctx.notify(creator.user_id, 'orb_suggestion', {
      title: 'This Week\'s Growth Tip',
      body: tip,
      data: { url: '/business/earnings' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

export function registerBusinessOpportunityHandlers(): void {
  registerHandler('runMarketplaceGapDetection', runMarketplaceGapDetection);
  registerHandler('runRevenueOpportunityAlert', runRevenueOpportunityAlert);
  registerHandler('runServiceDemandMatching', runServiceDemandMatching);
  registerHandler('runBusinessSetupCoach', runBusinessSetupCoach);
  registerHandler('runIncomeGrowthTips', runIncomeGrowthTips);
}
