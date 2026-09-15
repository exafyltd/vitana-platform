// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references intent-trust-gate.ts — zero coverage today.
/**
 * services/intent-trust-gate.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in intent-trust-gate.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchIntentTierRequiredRules(sb: SupabaseClient, intentKind: string) {
  return sb
    .from('intent_tier_required')
    .select('intent_kind, category_prefix, payload_match, required_tier, reason')
    .eq('intent_kind', intentKind);
}

export async function fetchUserTrustTier(sb: SupabaseClient, userId: string) {
  return sb.from('user_reputation').select('trust_tier').eq('user_id', userId).maybeSingle();
}
