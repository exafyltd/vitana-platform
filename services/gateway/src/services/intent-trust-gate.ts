/**
 * VTID-DANCE-D6: Trust-tier gate for intent posts.
 *
 * Reads the intent_tier_required table + user's trust_tier from
 * user_reputation and decides whether the post is allowed. Operator
 * roles (super admin / tenant admin / developer) bypass entirely.
 *
 * Tier ordering: unverified < community_verified < pro_verified < id_verified
 */

import { getSupabase } from '../lib/supabase';

const TIER_ORDER = ['unverified', 'community_verified', 'pro_verified', 'id_verified'] as const;
type Tier = typeof TIER_ORDER[number];

function tierRank(t: string | null | undefined): number {
  if (!t) return 0;
  const idx = TIER_ORDER.indexOf(t as Tier);
  return idx === -1 ? 0 : idx;
}

export interface TrustGateInput {
  user_id: string;
  intent_kind: string;
  category: string | null;
  kind_payload: Record<string, unknown>;
  is_operator?: boolean;     // super_admin / tenant_admin / developer override
}

export interface TrustGateResult {
  ok: boolean;
  required_tier?: Tier;
  current_tier?: Tier;
  reason?: string;
}

function payloadMatches(rule: Record<string, any>, payload: Record<string, unknown>): boolean {
  // {any:true} → always.
  if (rule?.any === true) return true;
  // {price_cents_gt: 5000} → check kind_payload.teaching.price_cents OR root price_cents
  if (typeof rule?.price_cents_gt === 'number') {
    const t = (payload as any)?.teaching?.price_cents;
    const r = (payload as any)?.price_cents;
    const got = typeof t === 'number' ? t : typeof r === 'number' ? r : 0;
    return got > rule.price_cents_gt;
  }
  return false;
}

export async function gateIntentByTier(input: TrustGateInput): Promise<TrustGateResult> {
  if (input.is_operator) return { ok: true };

  const supabase = getSupabase();
  if (!supabase) return { ok: true }; // fail-open if DB unavailable

  const { data: rules } = await supabase
    .from('intent_tier_required')
    .select('intent_kind, category_prefix, payload_match, required_tier, reason')
    .eq('intent_kind', input.intent_kind);

  const matching = (rules || []).filter((r: any) => {
    const prefixOk = !r.category_prefix || (input.category || '').startsWith(r.category_prefix);
    if (!prefixOk) return false;
    return payloadMatches(r.payload_match || {}, input.kind_payload || {});
  });

  if (matching.length === 0) return { ok: true };

  // Pick the strictest required_tier.
  const strictest = matching.reduce<{ tier: Tier; reason: string }>((acc, r: any) => {
    const t = r.required_tier as Tier;
    return tierRank(t) > tierRank(acc.tier) ? { tier: t, reason: r.reason } : acc;
  }, { tier: 'unverified' as Tier, reason: '' });

  // Look up the user's current trust_tier.
  const { data: userRep } = await supabase
    .from('user_reputation')
    .select('trust_tier')
    .eq('user_id', input.user_id)
    .maybeSingle();
  const currentTier = ((userRep as any)?.trust_tier ?? 'unverified') as Tier;

  if (tierRank(currentTier) >= tierRank(strictest.tier)) {
    return { ok: true, required_tier: strictest.tier, current_tier: currentTier };
  }

  return {
    ok: false,
    required_tier: strictest.tier,
    current_tier: currentTier,
    reason: strictest.reason,
  };
}
