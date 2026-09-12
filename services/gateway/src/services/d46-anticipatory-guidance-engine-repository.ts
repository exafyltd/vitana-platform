// impact-allow-no-test: pure data-access seam (thin Supabase query/RPC
// wrappers, no independent request-handling behavior). Coverage note:
// test/d46-anticipatory-guidance-engine.test.ts only imports and
// exercises the pure helper functions (validateGuidanceLanguage,
// calculateRelevanceScore, generateGuidance, etc.) — no authToken is
// ever passed, and isDevSandbox() is false in the test environment
// (ENVIRONMENT/VITANA_ENV unset), so getClientWithContext() always
// short-circuits to UNAUTHENTICATED before any of these call sites
// execute. Zero genuine coverage today.
/**
 * services/d46-anticipatory-guidance-engine.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * d46-anticipatory-guidance-engine.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function bootstrapDevRequestContext(sb: SupabaseClient, tenantId: string) {
  return sb.rpc('dev_bootstrap_request_context', {
    p_tenant_id: tenantId,
    p_active_role: 'developer',
  });
}

export async function insertAnticipatoryGuidanceRecords(sb: SupabaseClient, records: Record<string, unknown>[]) {
  return sb.from('anticipatory_guidance').insert(records);
}

export async function fetchGuidanceHistory(
  sb: SupabaseClient,
  args: { limit: number; domains?: string[]; status?: string[]; since?: string },
) {
  let query = sb
    .from('anticipatory_guidance')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(args.limit);

  if (args.domains && args.domains.length > 0) {
    query = query.in('domain', args.domains);
  }
  if (args.status && args.status.length > 0) {
    query = query.in('status', args.status);
  }
  if (args.since) {
    query = query.gte('created_at', args.since);
  }

  return query;
}

export async function updateGuidanceInteraction(
  sb: SupabaseClient,
  guidanceId: string,
  updateData: Record<string, unknown>,
) {
  return sb
    .from('anticipatory_guidance')
    .update(updateData)
    .eq('id', guidanceId)
    .select('domain, guidance_mode')
    .single();
}
