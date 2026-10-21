// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references orb/delegation/usage.ts — zero coverage today.
/**
 * orb/delegation/usage.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in usage.ts now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * insert, same row shape, same return shape — no behavior change
 * today. The source file's fire-and-forget `.then(...)` chaining
 * (never awaited) is preserved exactly. Client-agnostic (takes `sb` as
 * a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export function insertAiUsageLog(
  sb: SupabaseClient,
  row: Record<string, unknown>,
): PromiseLike<{ error: { message: string } | null }> {
  return sb.from('ai_usage_log').insert(row);
}
