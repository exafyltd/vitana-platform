// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// all 6 referencing test files wholesale jest.mock i18n/server-locale.ts
// itself — zero genuine coverage of these queries today.
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
  return sb
    .from('memory_facts')
    .select('fact_value')
    .eq('user_id', userId)
    .eq('fact_key', 'preferred_language')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchAppUserLocalesForIds(sb: SupabaseClient, userIds: string[]) {
  return sb.from('app_users').select('user_id, locale').in('user_id', userIds);
}

export async function fetchUserPreferenceSttLanguagesForIds(sb: SupabaseClient, userIds: string[]) {
  return sb.from('user_preferences').select('user_id, stt_language').in('user_id', userIds);
}
