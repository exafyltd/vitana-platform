// Coverage note: test/d48-opportunity-surfacing.test.ts exercises this
// route against a mocked '@supabase/supabase-js' createClient (a
// functional fake, not a wholesale mock of this repository module), so
// these wrappers get genuine coverage, not a documented zero.
/**
 * routes/opportunity-surfacing.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in opportunity-surfacing.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 *
 * `fetchContextualOpportunitiesHistory` resolves the terminal await
 * inside an async function (rather than returning a partial builder)
 * so the source's optional status/types/since conditional filters
 * still apply before the query executes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchContextualOpportunitiesHistory(
  sb: SupabaseClient,
  args: { tenantId: string; userId: string; limit: number; statuses: string[] | null; types: string[] | null; since: string | null },
) {
  let query = sb
    .from('contextual_opportunities')
    .select('*')
    .eq('tenant_id', args.tenantId)
    .eq('user_id', args.userId)
    .order('created_at', { ascending: false })
    .limit(args.limit);

  if (args.statuses) {
    query = query.in('status', args.statuses);
  }
  if (args.types) {
    query = query.in('opportunity_type', args.types);
  }
  if (args.since) {
    query = query.gte('created_at', args.since);
  }

  return query;
}

export async function fetchContextualOpportunitiesForStats(
  sb: SupabaseClient,
  args: { tenantId: string; userId: string; sinceIso: string },
) {
  return sb
    .from('contextual_opportunities')
    .select('status, opportunity_type, priority_domain')
    .eq('tenant_id', args.tenantId)
    .eq('user_id', args.userId)
    .gte('created_at', args.sinceIso);
}
