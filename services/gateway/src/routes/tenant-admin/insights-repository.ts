// Genuinely tested via test/routes/tenant-admin/insights.test.ts, which
// drives a functional fake Supabase client — not a wholesale module
// mock.
/**
 * routes/tenant-admin/insights.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in tenant-admin/insights.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 *
 * `listAdminInsights` preserves the source's conditional status/domain/
 * severity/scanner filter chain.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function listAdminInsights(
  sb: SupabaseClient,
  args: {
    tenantId: string;
    statusParam: string;
    domain: string | null;
    severity: string | null;
    scanner: string | null;
    limit: number;
  },
) {
  let query = sb
    .from('admin_insights')
    .select('*')
    .eq('tenant_id', args.tenantId)
    .order('severity', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(args.limit);

  if (args.statusParam === 'all') {
    // no status filter
  } else if (args.statusParam) {
    query = query.eq('status', args.statusParam);
  } else {
    query = query.in('status', ['open', 'pending_approval']);
  }
  if (args.domain) query = query.eq('domain', args.domain);
  if (args.severity) query = query.eq('severity', args.severity);
  if (args.scanner) query = query.eq('scanner', args.scanner);

  return query;
}

export async function fetchAdminInsightById(sb: SupabaseClient, tenantId: string, insightId: string) {
  return sb.from('admin_insights').select('*').eq('tenant_id', tenantId).eq('id', insightId).maybeSingle();
}

export async function updateAdminInsightStatus(
  sb: SupabaseClient,
  tenantId: string,
  insightId: string,
  update: Record<string, unknown>,
) {
  return sb
    .from('admin_insights')
    .update(update)
    .eq('tenant_id', tenantId)
    .eq('id', insightId)
    .select()
    .single();
}
