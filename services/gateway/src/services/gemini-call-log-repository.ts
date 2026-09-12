// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: no
// test file references gemini-call-log.ts — zero coverage today.
/**
 * services/gemini-call-log.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in gemini-call-log.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same insert, same row shape, same return shape — no behavior
 * change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertGeminiCallLog(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('gemini_call_log').insert(row as any);
}
