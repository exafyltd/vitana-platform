/**
 * Business Hub & Marketplace Handlers — AP-1100 series
 *
 * VTID: VTID-01250
 * Automations for shop setup, product/service distribution, and Discover personalization.
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// ── AP-1101: Service Listing Publication & Distribution ──────
async function runServiceListingDistribution(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { service_id, user_id } = payload || {};
  if (!service_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: service } = await supabase
    .from('services_catalog')
    .select('name, service_type, topic_keys')
    .eq('id', service_id)
    .maybeSingle();

  if (!service) return { usersAffected: 0, actionsTaken: 0 };

  // Find users with matching topics
  const topicKeys = service.topic_keys || [];
  if (!topicKeys.length) return { usersAffected: 0, actionsTaken: 1 };

  const { data: matchingUsers } = await supabase
    .from('user_topic_profile')
    .select('user_id, score')
    .eq('tenant_id', tenantId)
    .in('topic_key', topicKeys)
    .gte('score', 60)
    .order('score', { ascending: false })
    .limit(50);

  let usersAffected = 0;
  const uniqueUsers = new Set<string>();
  for (const match of matchingUsers || []) {
    if (match.user_id === user_id) continue; // don't notify creator
    if (uniqueUsers.has(match.user_id)) continue;
    uniqueUsers.add(match.user_id);

    // Create relationship edge for discovery
    await supabase.from('relationship_edges').upsert({
      tenant_id: tenantId,
      user_id: match.user_id,
      target_type: 'service',
      target_id: service_id,
      relationship_type: 'saved',
      strength: Math.round(match.score * 0.5),
      context: JSON.stringify({ origin: 'autopilot_marketplace' }),
    }, { onConflict: 'tenant_id,user_id,target_type,target_id' });

    usersAffected++;
  }

  await ctx.emitEvent('autopilot.marketplace.service_listed', {
    service_id, service_type: service.service_type, matched_users: usersAffected,
  });

  return { usersAffected, actionsTaken: usersAffected + 1 };
}

// ── AP-1102: Product Listing & AI-Picks Matching ────────────
async function runProductAiPicksMatching(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { product_id, user_id } = payload || {};
  if (!product_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: product } = await supabase
    .from('products_catalog')
    .select('name, product_type, topic_keys')
    .eq('id', product_id)
    .maybeSingle();

  if (!product) return { usersAffected: 0, actionsTaken: 0 };

  // Find users with matching recommendations
  const topicKeys = product.topic_keys || [];
  const { data: matchingRecs } = await supabase
    .from('recommendations')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .overlaps('pillar', topicKeys)
    .limit(50);

  let usersAffected = 0;
  for (const rec of matchingRecs || []) {
    if (rec.user_id === user_id) continue;
    usersAffected++;
  }

  await ctx.emitEvent('autopilot.marketplace.product_listed', {
    product_id, product_type: product.product_type, matched_users: usersAffected,
  });

  return { usersAffected, actionsTaken: 1 };
}

// ── AP-1103: Discover Section Personalization ───────────────
async function runDiscoverPersonalization(ctx: AutomationContext) {
  ctx.log('Running Discover personalization refresh (delegates to offers API)');
  await ctx.emitEvent('autopilot.marketplace.discover_personalized', {});
  return { usersAffected: 0, actionsTaken: 1 };
}

// ── AP-1104: Client-Service Matching ────────────────────────
async function runClientServiceMatching(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, query, service_type } = payload || {};
  if (!user_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: services } = await supabase
    .from('services_catalog')
    .select('id, name, service_type, provider_name, topic_keys')
    .eq('tenant_id', tenantId)
    .eq('service_type', service_type || 'coach')
    .limit(3);

  if (!services?.length) return { usersAffected: 0, actionsTaken: 0 };

  // Track user interest
  for (const service of services) {
    await supabase.from('user_offers_memory').upsert({
      tenant_id: tenantId,
      user_id,
      target_type: 'service',
      target_id: service.id,
      state: 'viewed',
    }, { onConflict: 'tenant_id,user_id,target_type,target_id' });
  }

  await ctx.emitEvent('autopilot.marketplace.client_matched', { user_id, matches: services.length });
  return { usersAffected: 1, actionsTaken: services.length };
}

// ── AP-1105: Post-Service Outcome Tracking ──────────────────
async function runPostServiceOutcomeTracking(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  const { data: recentUses } = await supabase
    .from('user_offers_memory')
    .select('user_id, target_id, target_type')
    .eq('tenant_id', tenantId)
    .eq('state', 'used')
    .eq('target_type', 'service')
    .gte('updated_at', eightDaysAgo)
    .lte('updated_at', sevenDaysAgo)
    .limit(50);

  for (const usage of recentUses || []) {
    // Check if outcome already recorded
    const { count } = await supabase
      .from('usage_outcomes')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('user_id', usage.user_id)
      .eq('target_id', usage.target_id);

    if ((count || 0) > 0) continue;

    ctx.notify(usage.user_id, 'orb_proactive_message', {
      title: 'How Was Your Experience?',
      body: 'Tell us about your recent service — your feedback helps others.',
      data: { url: '/discover', target_id: usage.target_id },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1106: Shop Setup Wizard ──────────────────────────────
async function runShopSetupWizard(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  ctx.notify(userId, 'orb_proactive_message', {
    title: 'Welcome to Vitana Business!',
    body: 'Let\'s get your shop set up. Start by creating your first service or product listing.',
    data: { url: '/business/setup' },
  });

  await ctx.emitEvent('autopilot.marketplace.shop_setup_started', { user_id: userId });
  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-1107: Product Review Follow-Up ───────────────────────
async function runProductReviewFollowUp(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

  const { data: productUses } = await supabase
    .from('user_offers_memory')
    .select('user_id, target_id')
    .eq('tenant_id', tenantId)
    .eq('state', 'used')
    .eq('target_type', 'product')
    .gte('updated_at', fifteenDaysAgo)
    .lte('updated_at', fourteenDaysAgo)
    .limit(50);

  for (const usage of productUses || []) {
    const { data: product } = await supabase
      .from('products_catalog')
      .select('name')
      .eq('id', usage.target_id)
      .maybeSingle();

    ctx.notify(usage.user_id, 'orb_proactive_message', {
      title: 'How Is It Working?',
      body: `How is ${product?.name || 'your product'} working for you? A review helps other members.`,
      data: { url: '/discover', target_id: usage.target_id },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1110: Cross-Sell Service to Product Buyers ───────────
async function runCrossSellServiceToProductBuyers(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, product_id } = payload || {};
  if (!user_id || !product_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: product } = await supabase
    .from('products_catalog')
    .select('topic_keys')
    .eq('id', product_id)
    .maybeSingle();

  if (!product?.topic_keys?.length) return { usersAffected: 0, actionsTaken: 0 };

  const { data: services } = await supabase
    .from('services_catalog')
    .select('id, name, service_type')
    .eq('tenant_id', tenantId)
    .overlaps('topic_keys', product.topic_keys)
    .limit(1)
    .maybeSingle();

  if (!services) return { usersAffected: 0, actionsTaken: 0 };

  // Don't suggest immediately — wait 3 days (tracked by heartbeat)
  ctx.notify(user_id, 'orb_suggestion', {
    title: 'Get More From Your Purchase',
    body: `A ${services.service_type} can help you optimize your results. Check Discover.`,
    data: { url: '/discover', filter: services.service_type },
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

export function registerBusinessMarketplaceHandlers(): void {
  registerHandler('runServiceListingDistribution', runServiceListingDistribution);
  registerHandler('runProductAiPicksMatching', runProductAiPicksMatching);
  registerHandler('runDiscoverPersonalization', runDiscoverPersonalization);
  registerHandler('runClientServiceMatching', runClientServiceMatching);
  registerHandler('runPostServiceOutcomeTracking', runPostServiceOutcomeTracking);
  registerHandler('runShopSetupWizard', runShopSetupWizard);
  registerHandler('runProductReviewFollowUp', runProductReviewFollowUp);
  registerHandler('runCrossSellServiceToProductBuyers', runCrossSellServiceToProductBuyers);
}
