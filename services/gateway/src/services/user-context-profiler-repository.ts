// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file exercises this module's own DB call sites — the dedicated
// test/services/user-context-profiler-account.test.ts only imports the
// pure buildAccountSection() formatter (takes a pre-fetched AccountRow,
// never touches Supabase); every other test reference wholesale
// jest.mocks the module. Zero genuine coverage.
/**
 * services/user-context-profiler.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in user-context-profiler.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic
 * (including fetchLifeCompass's column-fallback retry), same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingSchema } from './timeline/timeline-repository';

const INDEX_SELECT_COLUMNS =
  'date, score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental, model_version, feature_inputs, confidence';

export async function readProfilerVersion(sb: SupabaseClient, userId: string) {
  return sb.from('user_profiler_version').select('version').eq('user_id', userId).maybeSingle();
}

/**
 * VTID-05171 (Life Timeline P5): only what the member sees and lets Vitana
 * learn from — tier spotlight/moment/digest, not hidden_from_ai, not in a
 * category the member switched off — filtered in the query itself, so the
 * 400-row window is no longer filled with screen views and ORB telemetry.
 * Before the VTID-05167 migration (no tier column) it falls back to the
 * unfiltered query and the profiler's own prefix filters, as before.
 */
export const PROFILER_VISIBLE_TIERS = ['spotlight', 'moment', 'digest'] as const;

export async function fetchActivityLogRows(sb: SupabaseClient, userId: string, sinceIso: string, offCategories: string[] = []) {
  let filtered = sb
    .from('user_activity_log')
    .select('activity_type, activity_data, created_at')
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .in('tier', [...PROFILER_VISIBLE_TIERS])
    .eq('hidden_from_ai', false);
  const off = offCategories.filter((c) => /^[a-z_]+$/.test(c));
  if (off.length) filtered = filtered.not('category', 'in', `(${off.join(',')})`);
  const res = await filtered.order('created_at', { ascending: false }).limit(400);
  if (!res.error || !isMissingSchema(res.error)) return res;
  return sb
    .from('user_activity_log')
    .select('activity_type, activity_data, created_at')
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(400);
}

/** VTID-05171: the Index movements of the last days (VTID-05168 table), newest first. */
export async function fetchIndexMovementsSince(sb: SupabaseClient, userId: string, sinceIso: string) {
  return sb
    .from('vitana_index_movements')
    .select('at, trigger, delta_total, delta_pillars')
    .eq('user_id', userId)
    .gte('at', sinceIso)
    .order('at', { ascending: false })
    .limit(200);
}

export async function fetchRoutineRows(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_routines')
    .select('routine_kind, title, summary, confidence')
    .eq('user_id', userId)
    .gte('confidence', 0.5)
    .order('confidence', { ascending: false })
    .limit(8);
}

export async function fetchAppUsersAccountRow(sb: SupabaseClient, userId: string) {
  return sb.from('app_users').select('created_at').eq('user_id', userId).maybeSingle();
}

/** fetchLifeCompass's column-fallback query — same builder for both the
 * extended-columns attempt and the base-columns retry on error. */
export async function queryLifeCompass(sb: SupabaseClient, userId: string, cols: string) {
  return sb.from('life_compass').select(cols).eq('user_id', userId).eq('is_active', true).order('created_at', { ascending: false }).limit(1);
}

export async function fetchVitanaIndexRecent(sb: SupabaseClient, userId: string, sinceDate: string) {
  return sb.from('vitana_index_scores').select(INDEX_SELECT_COLUMNS).eq('user_id', userId).gte('date', sinceDate).order('date', { ascending: true }).limit(14);
}

export async function fetchVitanaIndexLatest(sb: SupabaseClient, userId: string) {
  return sb.from('vitana_index_scores').select(INDEX_SELECT_COLUMNS).eq('user_id', userId).order('date', { ascending: false }).limit(1);
}

export async function fetchVitanaIndexBaselineSurveyExists(sb: SupabaseClient, userId: string) {
  return sb.from('vitana_index_baseline_survey').select('user_id').eq('user_id', userId).limit(1).maybeSingle();
}

export async function fetchLatestIndexRecomputedEvent(sb: SupabaseClient, userId: string) {
  return sb
    .from('oasis_events')
    .select('topic, payload, created_at')
    .eq('actor_id', userId)
    .eq('topic', 'index.recomputed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchFirstVitanaIndexScoreDate(sb: SupabaseClient, userId: string) {
  return sb.from('vitana_index_scores').select('date').eq('user_id', userId).order('date', { ascending: true }).limit(1).maybeSingle();
}
