// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior). Coverage note: the
// upsertLesson call sites are genuinely exercised indirectly by
// test/watcher-observer.test.ts's distillation-wiring tests (real
// lessons-store code against a mocked ../lib/supabase client). The
// loadLessons/loadRules call sites are only reached through
// services/watcher/reminder.ts, whose own test
// (test/watcher-reminder.test.ts) mocks lessons-store wholesale — no
// genuine test exercises their query bodies today. recordRecurrence has no
// production caller at all currently (dead code) and so has no coverage,
// direct or indirect, before or after this seam.
/**
 * services/watcher/lessons-store.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in lessons-store.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== watcher_lessons ====================

export async function fetchExistingLesson(
  sb: SupabaseClient,
  stage: string,
  patternType: string,
  patternKey: string,
) {
  return sb
    .from('watcher_lessons')
    .select('id, frequency, evidence_step_ids')
    .eq('stage', stage)
    .eq('pattern_type', patternType)
    .eq('pattern_key', patternKey)
    .maybeSingle();
}

export async function updateExistingLesson(
  sb: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
) {
  return sb.from('watcher_lessons').update(patch).eq('id', id);
}

export async function insertNewLesson(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('watcher_lessons').insert(row);
}

export async function fetchLessonFrequency(sb: SupabaseClient, lessonId: string) {
  return sb.from('watcher_lessons').select('frequency, confidence').eq('id', lessonId).maybeSingle();
}

export async function updateLessonRecurrence(
  sb: SupabaseClient,
  lessonId: string,
  patch: { frequency: number; confidence: number; last_seen_at: string },
) {
  return sb.from('watcher_lessons').update(patch).eq('id', lessonId);
}

export async function fetchActiveLessonsForStages(
  sb: SupabaseClient,
  stages: string[],
  since: string,
  limit: number,
) {
  return sb
    .from('watcher_lessons')
    .select('id, stage, pattern_type, pattern_key, scope, lesson, example_message, mitigation_note, frequency, confidence, status, last_seen_at')
    .in('stage', stages)
    .eq('status', 'active')
    .gte('last_seen_at', since)
    .order('last_seen_at', { ascending: false })
    .limit(limit);
}

// ==================== watcher_rules ====================

export async function fetchEnabledRulesForStages(sb: SupabaseClient, stages: string[]) {
  return sb
    .from('watcher_rules')
    .select('rule_key, source_ref, stage, trigger, reminder, severity, enabled')
    .in('stage', stages)
    .eq('enabled', true);
}
