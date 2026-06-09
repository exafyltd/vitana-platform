/**
 * VTID-03277 — Guided Journey checklist service (P2).
 *
 * CRUD + read paths over journey_checklist_topics, plus the user-facing
 * published read (My Journey). The HTTP layer (routes/journey-checklist.ts)
 * delegates here; tests exercise these with a mocked Supabase client.
 *
 * Mutations write an audit row. This module touches ONLY curriculum tables.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ChecklistTopic,
  ChecklistTopicRow,
  PublicChecklistTopic,
  ChecklistStatus,
  BusinessGate,
} from '../../types/journey-checklist';

const T = 'journey_checklist_topics';
const V = 'journey_checklist_versions';
const A = 'journey_checklist_audit';

export function rowToTopic(r: ChecklistTopicRow): ChecklistTopic {
  return {
    topicId: r.topic_id,
    curriculumVersion: r.curriculum_version,
    session: r.session,
    position: r.position,
    chapterId: r.chapter_id,
    displayLabel: r.display_label,
    title: r.title,
    shortDescription: r.short_description,
    vitanaVoiceScript: r.vitana_voice_script,
    explanation: {
      whatItIs: r.explanation_what_it_is,
      userBenefit: r.explanation_user_benefit,
      whenToUse: r.explanation_when_to_use,
      tryThis: r.explanation_try_this,
    },
    guidedPracticeTarget: r.guided_practice_target,
    practiceActionType: r.practice_action_type,
    completionEvent: r.completion_event,
    unlockRule: r.unlock_rule,
    safetyLevel: r.safety_level,
    businessGate: r.business_gate,
    sourceRefs: r.source_refs ?? [],
    manualPath: r.manual_path,
    fallbackTopicId: r.fallback_topic_id,
    status: r.status,
    enabled: r.enabled,
    updatedByAdminId: r.updated_by_admin_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Strip internal fields → the user-facing shape My Journey renders. */
export function toPublicTopic(t: ChecklistTopic): PublicChecklistTopic {
  return {
    topicId: t.topicId,
    session: t.session,
    position: t.position,
    chapterId: t.chapterId,
    displayLabel: t.displayLabel,
    shortDescription: t.shortDescription,
    explanation: t.explanation,
    guidedPracticeTarget: t.guidedPracticeTarget,
    businessGate: t.businessGate,
  };
}

export interface ListFilters {
  curriculumVersion?: string;
  session?: number;
  chapterId?: string;
  status?: ChecklistStatus;
  businessGate?: BusinessGate;
  search?: string;
}

export async function listTopics(
  client: SupabaseClient,
  filters: ListFilters = {},
): Promise<ChecklistTopic[]> {
  let q = client.from(T).select('*').eq('curriculum_version', filters.curriculumVersion ?? 'v2');
  if (filters.session != null) q = q.eq('session', filters.session);
  if (filters.chapterId) q = q.eq('chapter_id', filters.chapterId);
  if (filters.status) q = q.eq('status', filters.status);
  if (filters.businessGate) q = q.eq('business_gate', filters.businessGate);
  if (filters.search) q = q.ilike('display_label', `%${filters.search}%`);
  q = q.order('session', { ascending: true }).order('position', { ascending: true });
  const { data, error } = await q;
  if (error) throw error;
  return (data as ChecklistTopicRow[]).map(rowToTopic);
}

export async function getTopic(
  client: SupabaseClient,
  topicId: string,
): Promise<ChecklistTopic | null> {
  const { data, error } = await client.from(T).select('*').eq('topic_id', topicId).maybeSingle();
  if (error) throw error;
  return data ? rowToTopic(data as ChecklistTopicRow) : null;
}

/** Fields an admin may write. Maps camelCase patch → DB columns. */
export interface TopicPatch {
  curriculumVersion?: string;
  session?: number;
  position?: number;
  chapterId?: string;
  displayLabel?: string;
  title?: string | null;
  shortDescription?: string | null;
  vitanaVoiceScript?: string | null;
  explanation?: Partial<ChecklistTopic['explanation']>;
  guidedPracticeTarget?: string | null;
  practiceActionType?: string | null;
  completionEvent?: string | null;
  unlockRule?: string | null;
  safetyLevel?: string;
  businessGate?: BusinessGate | null;
  sourceRefs?: string[];
  manualPath?: string | null;
  fallbackTopicId?: string | null;
  status?: ChecklistStatus;
  enabled?: boolean;
}

function patchToRow(patch: TopicPatch): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  if (patch.curriculumVersion !== undefined) r.curriculum_version = patch.curriculumVersion;
  if (patch.session !== undefined) r.session = patch.session;
  if (patch.position !== undefined) r.position = patch.position;
  if (patch.chapterId !== undefined) r.chapter_id = patch.chapterId;
  if (patch.displayLabel !== undefined) r.display_label = patch.displayLabel;
  if (patch.title !== undefined) r.title = patch.title;
  if (patch.shortDescription !== undefined) r.short_description = patch.shortDescription;
  if (patch.vitanaVoiceScript !== undefined) r.vitana_voice_script = patch.vitanaVoiceScript;
  if (patch.explanation) {
    if (patch.explanation.whatItIs !== undefined) r.explanation_what_it_is = patch.explanation.whatItIs;
    if (patch.explanation.userBenefit !== undefined) r.explanation_user_benefit = patch.explanation.userBenefit;
    if (patch.explanation.whenToUse !== undefined) r.explanation_when_to_use = patch.explanation.whenToUse;
    if (patch.explanation.tryThis !== undefined) r.explanation_try_this = patch.explanation.tryThis;
  }
  if (patch.guidedPracticeTarget !== undefined) r.guided_practice_target = patch.guidedPracticeTarget;
  if (patch.practiceActionType !== undefined) r.practice_action_type = patch.practiceActionType;
  if (patch.completionEvent !== undefined) r.completion_event = patch.completionEvent;
  if (patch.unlockRule !== undefined) r.unlock_rule = patch.unlockRule;
  if (patch.safetyLevel !== undefined) r.safety_level = patch.safetyLevel;
  if (patch.businessGate !== undefined) r.business_gate = patch.businessGate;
  if (patch.sourceRefs !== undefined) r.source_refs = patch.sourceRefs;
  if (patch.manualPath !== undefined) r.manual_path = patch.manualPath;
  if (patch.fallbackTopicId !== undefined) r.fallback_topic_id = patch.fallbackTopicId;
  if (patch.status !== undefined) r.status = patch.status;
  if (patch.enabled !== undefined) r.enabled = patch.enabled;
  return r;
}

async function audit(
  client: SupabaseClient,
  action: string,
  opts: { adminId?: string | null; topicId?: string; versionId?: string; changedFields?: unknown; detail?: string },
): Promise<void> {
  await client.from(A).insert({
    actor_admin_id: opts.adminId ?? null,
    action,
    topic_id: opts.topicId ?? null,
    version_id: opts.versionId ?? null,
    changed_fields: opts.changedFields ?? null,
    detail: opts.detail ?? null,
  });
}

export async function updateTopic(
  client: SupabaseClient,
  topicId: string,
  patch: TopicPatch,
  adminId: string,
  now: string = new Date().toISOString(),
): Promise<ChecklistTopic> {
  const row = { ...patchToRow(patch), updated_by_admin_id: adminId, updated_at: now };
  const { data, error } = await client.from(T).update(row).eq('topic_id', topicId).select('*').single();
  if (error) throw error;
  await audit(client, 'update', { adminId, topicId, changedFields: Object.keys(patch) });
  return rowToTopic(data as ChecklistTopicRow);
}

export interface NewTopicInput extends TopicPatch {
  topicId: string;
  session: number;
  position: number;
  chapterId: string;
  displayLabel: string;
}

export async function createTopic(
  client: SupabaseClient,
  input: NewTopicInput,
  adminId: string,
  now: string = new Date().toISOString(),
): Promise<ChecklistTopic> {
  const row = {
    topic_id: input.topicId,
    ...patchToRow(input),
    updated_by_admin_id: adminId,
    created_at: now,
    updated_at: now,
  };
  const { data, error } = await client.from(T).insert(row).select('*').single();
  if (error) throw error;
  await audit(client, 'create', { adminId, topicId: input.topicId });
  return rowToTopic(data as ChecklistTopicRow);
}

/** Disable (soft-remove from the catalog) or re-enable a topic. */
export async function setTopicDisabled(
  client: SupabaseClient,
  topicId: string,
  disabled: boolean,
  adminId: string,
  now: string = new Date().toISOString(),
): Promise<ChecklistTopic> {
  const { data, error } = await client
    .from(T)
    .update({ status: disabled ? 'disabled' : 'draft', enabled: !disabled, updated_by_admin_id: adminId, updated_at: now })
    .eq('topic_id', topicId)
    .select('*')
    .single();
  if (error) throw error;
  await audit(client, disabled ? 'disable' : 'enable', { adminId, topicId });
  return rowToTopic(data as ChecklistTopicRow);
}

/** Export the full working curriculum as domain objects (admin JSON export). */
export async function exportChecklist(
  client: SupabaseClient,
  curriculumVersion = 'v2',
): Promise<ChecklistTopic[]> {
  return listTopics(client, { curriculumVersion });
}

export interface PublishedChecklist {
  source: 'published' | 'draft_fallback';
  versionLabel: string | null;
  topics: PublicChecklistTopic[];
}

/**
 * The user-facing read for My Journey (P5). Returns the current published
 * snapshot; if nothing is published yet (early phases), falls back to the
 * enabled working draft so the catalog can still render (documented bootstrap
 * behavior — the spec allows a seed fallback when no published version exists).
 */
export async function getPublishedChecklist(
  client: SupabaseClient,
  curriculumVersion = 'v2',
): Promise<PublishedChecklist> {
  const { data: ver, error } = await client
    .from(V)
    .select('version_label, snapshot')
    .eq('curriculum_version', curriculumVersion)
    .eq('is_current', true)
    .maybeSingle();
  if (error) throw error;

  if (ver && Array.isArray((ver as any).snapshot)) {
    return {
      source: 'published',
      versionLabel: (ver as any).version_label ?? null,
      topics: (ver as any).snapshot as PublicChecklistTopic[],
    };
  }

  // Fallback: live working draft (enabled, not disabled).
  const working = (await listTopics(client, { curriculumVersion })).filter(
    (t) => t.enabled && t.status !== 'disabled',
  );
  return {
    source: 'draft_fallback',
    versionLabel: null,
    topics: working.map(toPublicTopic),
  };
}
