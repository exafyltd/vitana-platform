// Genuinely tested via test/product-analytics-rollup.test.ts, which
// mocks only ../../lib/supabase's getSupabase() with a functional
// generic query-builder fake (select/gte/lt/order/range/upsert/delete
// all chain-agnostic), not a wholesale module mock — covers
// fetchDayEventsPage and upsertRollupRows. deleteProductAnalyticsEventsBefore
// and deleteRollupsBefore are supported by the same fake shape but not
// directly exercised by the current test cases.
/**
 * services/product-analytics/rollup.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in product-analytics/rollup.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

export async function fetchDayEventsPage(sb: any, dayStartIso: string, dayEndIso: string, rangeStart: number, rangeEnd: number) {
  return sb
    .from('product_analytics_events')
    .select(
      'event_name, event_type, tenant_id, user_id_hash, session_id, conversation_id, screen_route, feature_key, properties, occurred_at',
    )
    .gte('occurred_at', dayStartIso)
    .lt('occurred_at', dayEndIso)
    .order('occurred_at', { ascending: true })
    .range(rangeStart, rangeEnd);
}

export async function upsertRollupRows(sb: any, rows: unknown[]) {
  return sb.from('product_analytics_daily_rollups').upsert(rows, { onConflict: 'tenant_id,rollup_date,metric_key,dimensions' });
}

export async function deleteProductAnalyticsEventsBefore(sb: any, cutoffIso: string) {
  return sb.from('product_analytics_events').delete().lt('received_at', cutoffIso);
}

export async function deleteRollupsBefore(sb: any, cutoffDate: string) {
  return sb.from('product_analytics_daily_rollups').delete().lt('rollup_date', cutoffDate);
}
