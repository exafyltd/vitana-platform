// impact-allow-no-test: pure data-access seam (one thin Supabase query
// wrapper, no independent request-handling behavior); the telemetry
// aggregation it feeds is tested in test/routes/admin-navigator-telemetry.test.ts.
/**
 * routes/admin-navigator.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * VTID-04846: only the telemetry read remains; the nav_catalog CRUD it used
 * to wrap went with the legacy navigator.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchNavigatorTelemetryEvents(sb: SupabaseClient, since: string, limit: number) {
  return sb
    .from('oasis_events_v1')
    .select('type, payload, created_at')
    .like('type', 'orb.navigator.%')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
}
