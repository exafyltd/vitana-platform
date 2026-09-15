// Genuinely tested via test/orb-tools/subscriptions-billing-tools.test.ts,
// which drives a real functional fake SupabaseClient (query-chain
// builder), not a wholesale module mock.
/**
 * orb-tools/subscriptions-billing-tools.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * orb-tools/subscriptions-billing-tools.ts now goes through here instead
 * of being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param) — tools
 * receive their client per-call, not a module-level singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchSubscriptionPlans(sb: SupabaseClient) {
  return sb.from('subscription_plans').select('plan_key, display_name, description');
}

export async function fetchSubscriptionPlanPrices(sb: SupabaseClient) {
  return sb.from('subscription_plan_prices').select('plan_key, price_key, billing_interval, price_cents, currency');
}
