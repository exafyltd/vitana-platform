// impact-allow-no-test
// Coverage note: test/routes/tenant-admin/product-analytics.test.ts
// exercises this route against a mocked '../../../lib/supabase' client
// (a functional fake, not a wholesale mock of this repository module),
// so these wrappers get genuine coverage, not a documented zero.
/**
 * routes/tenant-admin/product-analytics.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in tenant-admin/product-analytics.ts
 * now goes through here instead of being written inline. PURE MOVE, not
 * a rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic (takes
 * `sb` as a param).
 *
 * Both functions resolve the terminal await inside an async function
 * (rather than returning a partial builder) so the source's optional
 * conditional filters still apply before the query executes.
 */

export async function fetchProductAnalyticsEventsPage(
  sb: any,
  args: { columns: string; tenantId: string; sinceIso: string; eventTypes?: string[]; from: number; to: number },
) {
  let query = sb
    .from('product_analytics_events')
    .select(args.columns)
    .eq('tenant_id', args.tenantId)
    .gte('occurred_at', args.sinceIso);
  if (args.eventTypes && args.eventTypes.length > 0) query = query.in('event_type', args.eventTypes);

  return query.order('occurred_at', { ascending: false }).range(args.from, args.to);
}

export async function fetchProductAnalyticsEventsList(
  sb: any,
  args: { columns: string; tenantId: string; limit: number; eventName: string | null; eventType: string | null },
) {
  let query = sb
    .from('product_analytics_events')
    .select(args.columns)
    .eq('tenant_id', args.tenantId)
    .order('occurred_at', { ascending: false })
    .limit(args.limit);
  if (args.eventName) query = query.eq('event_name', args.eventName);
  if (args.eventType) query = query.eq('event_type', args.eventType);

  return query;
}
