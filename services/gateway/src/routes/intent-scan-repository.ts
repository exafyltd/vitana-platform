// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/intent-scan.ts — zero coverage today.
/**
 * routes/intent-scan.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in intent-scan.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 *
 * `fetchOpenCompatibleIntents` resolves the terminal `.order()`/`.limit()`
 * inside an async function (rather than returning a partial builder) so
 * the source's optional `categoryPrefix` conditional-`.like()` step still
 * runs before the query is awaited.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchCompatibleIntentKinds(sb: SupabaseClient, intentKind: string) {
  return sb.from('intent_compatibility').select('kind_b').eq('kind_a', intentKind);
}

export async function fetchOpenCompatibleIntents(
  sb: SupabaseClient,
  args: { compatibleKinds: string[]; requesterUserId: string; categoryPrefix: string | null },
) {
  let query = sb
    .from('user_intents')
    .select('intent_id, requester_vitana_id, intent_kind, category, title, scope, kind_payload, created_at')
    .in('intent_kind', args.compatibleKinds)
    .in('status', ['open', 'matched', 'engaged'])
    .neq('requester_user_id', args.requesterUserId)
    .order('created_at', { ascending: false })
    .limit(5);

  if (args.categoryPrefix) query = query.like('category', `${args.categoryPrefix}%`);

  return query;
}

export async function fetchDancePrefProfiles(sb: SupabaseClient, requesterUserId: string) {
  return sb
    .from('profiles')
    .select('user_id, vitana_id, display_name, city, dance_preferences')
    .neq('user_id', requesterUserId)
    .not('dance_preferences', 'eq', '{}')
    .limit(20);
}
