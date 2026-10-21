// impact-allow-no-test: pure data-access seam (thin Supabase query/upsert
// wrappers, no independent request-handling behavior). Coverage note:
// gatherSynthesisInputs' 4 call sites and synthesizeUserModel's 2 call
// sites (select-existing, upsert) are genuinely exercised by
// test/services/user-model-synthesis.test.ts against a real fake Supabase
// stub (only llm-router/@google-cloud/vertexai are jest.mock'd, not this
// module). readUserProfileNarrative's 1 call site is reached only via a
// dynamic import in user-context-profiler.ts and is not directly exercised
// by any test found in this repo today.
/**
 * services/user-model-synthesis.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in user-model-synthesis.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const MAX_FACTS_IN_PROMPT = 30;
const MAX_ROUTINES_IN_PROMPT = 5;

// ==================== gatherSynthesisInputs ====================

export async function fetchMemoryFactsForSynthesis(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('memory_facts')
    .select('fact_key, fact_value, provenance_source')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .is('superseded_at', null)
    .order('provenance_confidence', { ascending: false })
    .order('extracted_at', { ascending: false })
    .limit(MAX_FACTS_IN_PROMPT);
}

export async function fetchUserRoutinesForSynthesis(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_routines')
    .select('title, summary')
    .eq('user_id', userId)
    .order('confidence', { ascending: false })
    .limit(MAX_ROUTINES_IN_PROMPT);
}

export async function fetchActiveLifeCompassGoal(sb: SupabaseClient, userId: string) {
  return sb
    .from('life_compass')
    .select('primary_goal')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1);
}

export async function fetchLatestVitanaIndexScore(sb: SupabaseClient, userId: string) {
  return sb
    .from('vitana_index_scores')
    .select('score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(1);
}

// ==================== user_assistant_state ====================

export async function fetchExistingProfileNarrativeState(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  signalName: string,
) {
  return sb
    .from('user_assistant_state')
    .select('value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('signal_name', signalName)
    .maybeSingle();
}

export async function upsertProfileNarrativeState(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('user_assistant_state').upsert(row, { onConflict: 'tenant_id,user_id,signal_name' });
}

// ==================== VTID-04438 (WS-4.1): broader inputs ====================

export async function fetchRecentSessionSummaries(sb: SupabaseClient, userId: string, sinceIso: string, limit: number) {
  return sb
    .from('user_session_summaries')
    .select('summary, themes, ended_at')
    .eq('user_id', userId)
    .gte('ended_at', sinceIso)
    .order('ended_at', { ascending: false })
    .limit(limit);
}

export async function fetchRecentDiaryEntries(sb: SupabaseClient, userId: string, sinceIso: string, limit: number) {
  return sb
    .from('diary_entries')
    .select('text, created_at')
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit);
}
