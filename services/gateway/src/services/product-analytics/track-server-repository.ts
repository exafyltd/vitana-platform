// Genuine coverage: test/product-analytics-track-server.test.ts mocks only
// getSupabase() (via jest.mock('../src/lib/supabase', ...)), not this
// module — a real functional fake client, not a wholesale mock.
/**
 * services/product-analytics/track-server.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in track-server.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * insert, same row shape, same return shape — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertProductAnalyticsEvent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('product_analytics_events').insert(row);
}
