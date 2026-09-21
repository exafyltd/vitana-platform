// Genuine coverage: test/i18n/server-locale-repository.test.ts passes a
// hand-built functional fake client directly (no jest.mock()) and asserts
// on the exact table/column/filter/order calls issued — real coverage, not
// a mock. (Before that, all 6 referencing test files wholesale
// jest.mock'ed i18n/server-locale.ts itself, so these queries had zero
// genuine coverage.)
/**
 * i18n/server-locale.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in i18n/server-locale.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAppUserLocale(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('locale').eq('user_id', userId).maybeSingle();
}

export async function fetchUserPreferenceSttLanguage(sb: SupabaseClient, userId: string) {
  return sb.from('user_preferences').select('stt_language').eq('user_id', userId).maybeSingle();
}

export async function fetchLatestPreferredLanguageFact(sb: SupabaseClient, userId: string) {
  // memory_facts has NO created_at column (its timestamps are extracted_at /
  // superseded_at / updated_at) — ordering by created_at was a schema drift
  // that made PostgREST reject the query, silently disabling this last-resort
  // locale fallback. Order by the real extraction timestamp, exactly as
  // services/preference-facts-repository.ts does.
  return sb
    .from('memory_facts')
    .select('fact_value')
    .eq('user_id', userId)
    .eq('fact_key', 'preferred_language')
    .order('extracted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchAppUserLocalesForIds(sb: SupabaseClient, userIds: string[]) {
  return sb.from('app_users').select('user_id, locale').in('user_id', userIds);
}

export async function fetchUserPreferenceSttLanguagesForIds(sb: SupabaseClient, userIds: string[]) {
  return sb.from('user_preferences').select('user_id, stt_language').in('user_id', userIds);
}
