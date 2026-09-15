/**
 * guided-journey/checklist-publish.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in checklist-publish.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same filters, same return shapes — no
 * behavior change today. Client-agnostic (takes `client` as a param, same
 * parameter name checklist-publish.ts itself uses), same convention as
 * every other *-repository.ts in this codebase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const V = 'journey_checklist_versions';
const A = 'journey_checklist_audit';

const VERSION_SELECT =
  'id, version_label, curriculum_version, status, session_count, topic_count, is_current, note, published_by, published_at';

// ==================== journey_checklist_versions ====================

export async function fetchVersionsByCurriculum(client: SupabaseClient, curriculumVersion: string) {
  return client
    .from(V)
    .select(VERSION_SELECT)
    .eq('curriculum_version', curriculumVersion)
    .order('published_at', { ascending: false });
}

export async function unsetCurrentVersion(client: SupabaseClient, curriculumVersion: string) {
  return client
    .from(V)
    .update({ is_current: false })
    .eq('curriculum_version', curriculumVersion)
    .eq('is_current', true);
}

export async function insertPublishedVersion(client: SupabaseClient, row: Record<string, unknown>) {
  return client.from(V).insert(row).select(VERSION_SELECT).single();
}

export async function fetchVersionForRollback(client: SupabaseClient, versionId: string) {
  return client.from(V).select('id, curriculum_version').eq('id', versionId).maybeSingle();
}

export async function setVersionCurrent(client: SupabaseClient, versionId: string) {
  return client
    .from(V)
    .update({ is_current: true, status: 'published' })
    .eq('id', versionId)
    .select(VERSION_SELECT)
    .single();
}

// ==================== journey_checklist_audit ====================

export async function insertChecklistAudit(client: SupabaseClient, row: Record<string, unknown>) {
  return client.from(A).insert(row);
}
