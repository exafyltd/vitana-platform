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

/**
 * VTID-04572: the identity columns are split across two tables. Name, birth
 * date, gender and location live on `profiles`; only `locale` lives on
 * `app_users`. The block used to select all of them from `app_users`, which
 * has no `first_name`/`date_of_birth`/... at all — PostgREST refused every
 * call ("column app_users.first_name does not exist") and the brain never
 * learned the member's name or birthday.
 */
export const PROFILE_IDENTITY_COLUMNS = 'first_name,last_name,display_name,date_of_birth,gender,city,country';
export const APP_USER_IDENTITY_COLUMNS = 'locale';

export async function fetchProfileIdentityRow(
  sb: SupabaseClient,
  userId: string,
): Promise<{ data: any; error: any }> {
  return sb.from('profiles').select(PROFILE_IDENTITY_COLUMNS).eq('user_id', userId).limit(1).maybeSingle();
}

export async function fetchAppUserIdentityRow(
  sb: SupabaseClient,
  userId: string,
): Promise<{ data: any; error: any }> {
  return sb.from('app_users').select(APP_USER_IDENTITY_COLUMNS).eq('user_id', userId).limit(1).maybeSingle();
}
