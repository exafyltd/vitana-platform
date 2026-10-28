// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// test/watcher-reminder.test.ts imports only parseReminderId (a pure
// function, no DB access) from this module — zero genuine coverage of
// these queries today.
/**
 * services/watcher/feedback.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in services/watcher/feedback.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchWatcherLessonsShownCounts(sb: SupabaseClient, lessonIds: string[]) {
  return sb.from('watcher_lessons').select('id, shown_count').in('id', lessonIds);
}

export async function incrementWatcherLessonShownCount(sb: SupabaseClient, lessonId: string, newShownCount: number) {
  return sb.from('watcher_lessons').update({ shown_count: newShownCount }).eq('id', lessonId);
}

export async function insertWatcherReminderFeedback(
  sb: SupabaseClient,
  row: {
    reminder_id: string;
    kind: 'rule' | 'lesson';
    work_unit_id: string | null;
    vtid: string | null;
    stage: string | null;
    outcome: 'success' | 'failure' | 'unknown';
    repeated_mistake: boolean;
    note: string | null;
  },
) {
  return sb.from('watcher_reminder_feedback').insert(row);
}

export async function fetchWatcherLessonForFeedback(sb: SupabaseClient, lessonId: string) {
  return sb
    .from('watcher_lessons')
    .select('id, confidence, shown_count, helped_count, ignored_count, status')
    .eq('id', lessonId)
    .maybeSingle();
}

export async function updateWatcherLessonFeedback(
  sb: SupabaseClient,
  lessonId: string,
  patch: {
    confidence: number;
    helped_count: number;
    ignored_count: number;
    status?: 'muted';
  },
) {
  return sb.from('watcher_lessons').update(patch).eq('id', lessonId);
}
