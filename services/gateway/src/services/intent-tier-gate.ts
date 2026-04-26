/**
 * VTID-01973: Trust-tier gate (P2-A baseline).
 *
 * For commercial bids the user's vitana_id must clear a tier threshold:
 *   - Bid up to €200          → community_verified (3-vouch).
 *   - Bid up to €2000         → pro_verified (KYC-light).
 *   - Bid > €2000             → id_verified (govt ID).
 *
 * For partner_seek: only id_verified profiles unlock the mutual-reveal
 * vitana_id at the end of the protocol; community_verified can express
 * interest but reveal is held until tier upgrade.
 *
 * P2-A reads tier from a soft default: profiles that have completed Part 1
 * onboarding (vitana_id_locked=true) are treated as community_verified;
 * pro_verified / id_verified gating is the P2-B/C concern. The function
 * returns the tier so callers can branch.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
}

export type TrustTier = 'unverified' | 'community_verified' | 'pro_verified' | 'id_verified';

const TIER_RANK: Record<TrustTier, number> = {
  unverified: 0,
  community_verified: 1,
  pro_verified: 2,
  id_verified: 3,
};

interface GateResult {
  ok: boolean;
  tier: TrustTier;
  required?: TrustTier;
  reason?: string;
}

/**
 * Get the current tier for a user. P2-A baseline: vitana_id_locked=true
 * → community_verified. Future migrations add pro_verified and
 * id_verified mappings (manual review queues) — those callers will start
 * returning higher tiers without changing this signature.
 */
export async function getTrustTier(userId: string): Promise<TrustTier> {
  if (!userId) return 'unverified';
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from('profiles')
      .select('vitana_id_locked')
      .eq('user_id', userId)
      .maybeSingle();
    if (data && (data as any).vitana_id_locked === true) return 'community_verified';
    return 'unverified';
  } catch (err: any) {
    console.warn(`[VTID-01973] getTrustTier failed: ${err.message}`);
    return 'unverified';
  }
}

export async function gateCommercialBudget(userId: string, budgetMaxEur: number): Promise<GateResult> {
  const tier = await getTrustTier(userId);
  let required: TrustTier = 'community_verified';
  if (budgetMaxEur > 2000) required = 'pro_verified';
  if (budgetMaxEur > 10000) required = 'id_verified';

  if (TIER_RANK[tier] < TIER_RANK[required]) {
    return {
      ok: false,
      tier,
      required,
      reason: `Budget €${budgetMaxEur} requires ${required}; you are ${tier}.`,
    };
  }
  return { ok: true, tier };
}

export async function gatePartnerReveal(userId: string): Promise<GateResult> {
  const tier = await getTrustTier(userId);
  const required: TrustTier = 'id_verified';
  if (TIER_RANK[tier] < TIER_RANK[required]) {
    return {
      ok: false,
      tier,
      required,
      reason: `Partner-seek vitana_id reveal requires ${required}; you are ${tier}.`,
    };
  }
  return { ok: true, tier };
}
