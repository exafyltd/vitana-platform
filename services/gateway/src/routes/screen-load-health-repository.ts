// Genuine coverage: test/routes/screen-load-health.test.ts mocks only
// getSupabase() (via jest.mock('../../src/lib/supabase', ...)), not
// this module — a real functional fake client, not a wholesale mock.
/**
 * routes/screen-load-health.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in screen-load-health.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same columns, same filter logic, same return
 * shape — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchRecentScreenLoadHealthEvents(sb: SupabaseClient, topic: string, sinceIso: string) {
  return sb
    .from('oasis_events')
    .select('created_at, metadata')
    .eq('topic', topic)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(200);
}

/**
 * VTID-05062: newest `screen.load.daily_report` event, optionally for one
 * UTC report day (metadata.report_date). Read-only.
 */
export async function fetchLatestDailyReportEvent(
  sb: SupabaseClient,
  topic: string,
  opts: { reportDate?: string; env?: string } = {},
) {
  let q = sb.from('oasis_events').select('created_at, metadata').eq('topic', topic);
  if (opts.env) q = q.eq('metadata->>env', opts.env);
  if (opts.reportDate) q = q.eq('metadata->>report_date', opts.reportDate);
  return q.order('created_at', { ascending: false }).limit(1);
}
