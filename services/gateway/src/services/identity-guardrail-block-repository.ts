// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrapper, no independent request-handling behavior). Coverage note: the
// one referencing test file (vitana-brain.test.ts) wholesale
// jest.mock()s identity-guardrail-block.ts itself — zero genuine
// coverage today.
/**
 * services/identity-guardrail-block.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in identity-guardrail-block.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same query, same return shape — no behavior change today.
 * Client-agnostic (takes `sb` as a param).
 *
 * `columns` is passed in by the caller (its own `IDENTITY_COLUMNS`
 * constant) rather than duplicated/guessed here — a dynamic
 * `.select(someStringVariable)` collapses TS inference to
 * `GenericStringError`, so the return type is loosened explicitly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAppUserIdentityRow(
  sb: SupabaseClient,
  columns: string,
  userId: string,
): Promise<{ data: any; error: any }> {
  return sb.from('app_users').select(columns).eq('user_id', userId).maybeSingle();
}
