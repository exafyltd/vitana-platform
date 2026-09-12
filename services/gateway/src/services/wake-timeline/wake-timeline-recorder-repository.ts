// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// every referencing test (wake-timeline-recorder.test.ts,
// voice-wake-timeline-ingest.test.ts, wake-brief-wiring.test.ts, the
// wake acceptance suites) injects `getDb: () => null` — the recorder's
// DB-backed branches (`if (sb) { ... }`) never execute in tests, so
// these call sites have zero genuine coverage today.
/**
 * services/wake-timeline/wake-timeline-recorder.ts — Aurora migration
 * B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase
 * 3b/B1).
 *
 * Every Supabase `.from(...)` call in wake-timeline-recorder.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 *
 * `fetchRecentWakeTimelines` preserves the source's conditional
 * userId/tenantId filter chain.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function upsertWakeTimelineSession(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('orb_wake_timelines').upsert(row, { onConflict: 'session_id' });
}

export async function fetchWakeTimelineBySessionId(sb: SupabaseClient, sessionId: string) {
  return sb.from('orb_wake_timelines').select('*').eq('session_id', sessionId).maybeSingle();
}

export async function fetchRecentWakeTimelines(
  sb: SupabaseClient,
  args: { limit: number; userId?: string; tenantId?: string },
) {
  let q = sb.from('orb_wake_timelines').select('*').order('started_at', { ascending: false }).limit(args.limit);
  if (args.userId) q = q.eq('user_id', args.userId);
  if (args.tenantId) q = q.eq('tenant_id', args.tenantId);
  return q;
}
