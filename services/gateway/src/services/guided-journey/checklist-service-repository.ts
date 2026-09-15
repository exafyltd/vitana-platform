/**
 * guided-journey/checklist-service.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in checklist-service.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `client` as a
 * param, same parameter name checklist-service.ts itself uses), same
 * convention as every other *-repository.ts in this codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChecklistStatus, BusinessGate } from '../../types/journey-checklist';

const T = 'journey_checklist_topics';
const V = 'journey_checklist_versions';
const A = 'journey_checklist_audit';

export interface ListTopicsFilters {
  curriculumVersion?: string;
  session?: number;
  chapterId?: string;
  status?: ChecklistStatus;
  businessGate?: BusinessGate;
  search?: string;
}

// ==================== journey_checklist_topics ====================

export async function listChecklistTopics(client: SupabaseClient, filters: ListTopicsFilters = {}) {
  let q = client.from(T).select('*').eq('curriculum_version', filters.curriculumVersion ?? 'v2');
  if (filters.session != null) q = q.eq('session', filters.session);
  if (filters.chapterId) q = q.eq('chapter_id', filters.chapterId);
  if (filters.status) q = q.eq('status', filters.status);
  if (filters.businessGate) q = q.eq('business_gate', filters.businessGate);
  if (filters.search) q = q.ilike('display_label', `%${filters.search}%`);
  q = q.order('session', { ascending: true }).order('position', { ascending: true });
  return q;
}

export async function fetchChecklistTopicById(client: SupabaseClient, topicId: string) {
  return client.from(T).select('*').eq('topic_id', topicId).maybeSingle();
}

export async function updateChecklistTopic(client: SupabaseClient, topicId: string, row: Record<string, unknown>) {
  return client.from(T).update(row).eq('topic_id', topicId).select('*').single();
}

export async function insertChecklistTopic(client: SupabaseClient, row: Record<string, unknown>) {
  return client.from(T).insert(row).select('*').single();
}

export async function setChecklistTopicDisabled(client: SupabaseClient, topicId: string, row: Record<string, unknown>) {
  return client.from(T).update(row).eq('topic_id', topicId).select('*').single();
}

// ==================== journey_checklist_audit ====================

export async function insertChecklistServiceAudit(client: SupabaseClient, row: Record<string, unknown>) {
  return client.from(A).insert(row);
}

// ==================== journey_checklist_versions ====================

export async function fetchCurrentVersionSnapshot(client: SupabaseClient, curriculumVersion: string) {
  return client
    .from(V)
    .select('version_label, snapshot')
    .eq('curriculum_version', curriculumVersion)
    .eq('is_current', true)
    .maybeSingle();
}

export async function fetchCurrentVersionSnapshotOnly(client: SupabaseClient, curriculumVersion: string) {
  return client
    .from(V)
    .select('snapshot')
    .eq('curriculum_version', curriculumVersion)
    .eq('is_current', true)
    .maybeSingle();
}

// ==================== journey_checklist_translations ====================

export async function fetchChecklistTranslationRows(
  client: SupabaseClient,
  locale: string,
  topicIds: string[],
) {
  return client
    .from('journey_checklist_translations')
    .select(
      'topic_id, display_label, short_description, explanation_what_it_is, explanation_user_benefit, explanation_when_to_use, explanation_try_this',
    )
    .eq('locale', locale)
    .in('topic_id', topicIds);
}
