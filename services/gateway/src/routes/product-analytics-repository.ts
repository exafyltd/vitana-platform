// Genuine coverage: test/product-analytics.test.ts mocks only
// getSupabase() (via jest.mock('../src/lib/supabase', ...)), not this
// module — a real functional fake client, not a wholesale mock.
/**
 * routes/product-analytics.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in product-analytics.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same upsert, same conflict target, same return shape — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function upsertProductAnalyticsEventsBatch(sb: SupabaseClient, events: unknown[]) {
  return sb
    .from('product_analytics_events')
    .upsert(events, { onConflict: 'event_id', ignoreDuplicates: true });
}
