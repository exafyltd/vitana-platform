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
  SnapshotChecklistTopic,
  OrbTopicSeed,
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

/**
 * VTID-03289 — the SERVER-SIDE snapshot shape: the public fields PLUS the
 * `vitanaVoiceScript` the ORB voice bridge narrates. Stored in
 * `journey_checklist_versions.snapshot`; stripped back to `PublicChecklistTopic`
 * before it ever leaves the gateway over the public HTTP read (see
 * `snapshotToPublic` + `getPublishedChecklist`).
 */
export function toSnapshotTopic(t: ChecklistTopic): SnapshotChecklistTopic {
  return { ...toPublicTopic(t), vitanaVoiceScript: t.vitanaVoiceScript };
}

/**
 * VTID-03289 — re-strip a stored snapshot row to the user-facing shape. Picks
 * ONLY public fields, so even if the snapshot grows new internal fields later
 * they can never leak through the public HTTP read.
 */
export function snapshotToPublic(s: SnapshotChecklistTopic): PublicChecklistTopic {
  return {
    topicId: s.topicId,
    session: s.session,
    position: s.position,
    chapterId: s.chapterId,
    displayLabel: s.displayLabel,
    shortDescription: s.shortDescription,
    explanation: s.explanation,
    guidedPracticeTarget: s.guidedPracticeTarget,
    businessGate: s.businessGate,
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

/** Locales the curriculum can be served in. 'de' is the authored source. */
export type ChecklistLocale = 'de' | 'en' | 'es' | 'sr';

interface ChecklistTranslationRow {
  topic_id: string;
  display_label: string | null;
  short_description: string | null;
  explanation_what_it_is: string | null;
  explanation_user_benefit: string | null;
  explanation_when_to_use: string | null;
  explanation_try_this: string | null;
}

/**
 * Overlay per-locale translations onto the (German) public topics. Each field
 * falls back to the German source when a translation is absent — so a partially
 * translated locale still renders, never a blank. Pure/synchronous: the caller
 * fetches the rows. Exported for unit testing.
 */
export function applyTranslations(
  topics: PublicChecklistTopic[],
  translations: ChecklistTranslationRow[],
): PublicChecklistTopic[] {
  if (translations.length === 0) return topics;
  const byTopic = new Map<string, ChecklistTranslationRow>();
  for (const tr of translations) byTopic.set(tr.topic_id, tr);
  const pick = (translated: string | null | undefined, source: string | null) =>
    translated != null && translated !== '' ? translated : source;
  return topics.map((t) => {
    const tr = byTopic.get(t.topicId);
    if (!tr) return t;
    return {
      ...t,
      displayLabel: pick(tr.display_label, t.displayLabel) ?? t.displayLabel,
      shortDescription: pick(tr.short_description, t.shortDescription),
      explanation: {
        whatItIs: pick(tr.explanation_what_it_is, t.explanation.whatItIs),
        userBenefit: pick(tr.explanation_user_benefit, t.explanation.userBenefit),
        whenToUse: pick(tr.explanation_when_to_use, t.explanation.whenToUse),
        tryThis: pick(tr.explanation_try_this, t.explanation.tryThis),
      },
    };
  });
}

/** Fetch the translation rows for a locale + topic set. Best-effort: returns
 *  [] on any error so the German source is served rather than failing. */
async function fetchChecklistTranslations(
  client: SupabaseClient,
  locale: ChecklistLocale,
  topicIds: string[],
): Promise<ChecklistTranslationRow[]> {
  if (locale === 'de' || topicIds.length === 0) return [];
  try {
    const { data, error } = await client
      .from('journey_checklist_translations')
      .select(
        'topic_id, display_label, short_description, explanation_what_it_is, explanation_user_benefit, explanation_when_to_use, explanation_try_this',
      )
      .eq('locale', locale)
      .in('topic_id', topicIds);
    if (error || !Array.isArray(data)) return [];
    return data as ChecklistTranslationRow[];
  } catch {
    return [];
  }
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
  locale: ChecklistLocale = 'de',
): Promise<PublishedChecklist> {
  const { data: ver, error } = await client
    .from(V)
    .select('version_label, snapshot')
    .eq('curriculum_version', curriculumVersion)
    .eq('is_current', true)
    .maybeSingle();
  if (error) throw error;

  let result: PublishedChecklist;
  if (ver && Array.isArray((ver as any).snapshot)) {
    // VTID-03289: the stored snapshot now carries the internal vitanaVoiceScript
    // (for the ORB seam). Re-strip to the public shape so it never leaks over
    // this HTTP read. snapshotToPublic tolerates older voice-less snapshots.
    const snap = (ver as any).snapshot as SnapshotChecklistTopic[];
    result = {
      source: 'published',
      versionLabel: (ver as any).version_label ?? null,
      topics: snap.map(snapshotToPublic),
    };
  } else {
    // Fallback: live working draft (enabled, not disabled).
    const working = (await listTopics(client, { curriculumVersion })).filter(
      (t) => t.enabled && t.status !== 'disabled',
    );
    result = {
      source: 'draft_fallback',
      versionLabel: null,
      topics: working.map(toPublicTopic),
    };
  }

  // Overlay per-locale translations onto the German source (no-op for 'de' and
  // for any field/topic without a translation — those keep the German text).
  if (locale !== 'de' && result.topics.length > 0) {
    const translations = await fetchChecklistTranslations(
      client,
      locale,
      result.topics.map((t) => t.topicId),
    );
    result = { ...result, topics: applyTranslations(result.topics, translations) };
  }
  return result;
}

/**
 * VTID-03289 — the ORB voice bridge pickup. Given a tapped topicId, return the
 * narration seed (voice script + explanation + redirect target) for the ORB to
 * speak. Reads the CURRENT PUBLISHED snapshot first — so "Publish = go live" and
 * unpublished draft edits never leak into live narration — and only falls back
 * to the live draft when nothing is published yet (bootstrap), mirroring
 * `getPublishedChecklist`. Returns null when the topic is not live.
 */
export async function getOrbTopicSeed(
  client: SupabaseClient,
  topicId: string,
  curriculumVersion = 'v2',
): Promise<OrbTopicSeed | null> {
  const { data: ver, error } = await client
    .from(V)
    .select('snapshot')
    .eq('curriculum_version', curriculumVersion)
    .eq('is_current', true)
    .maybeSingle();
  if (error) throw error;

  // A published version is authoritative: if it exists, the ORB narrates ONLY
  // what's in it. A topic absent from the snapshot (gated/disabled at publish)
  // is intentionally not live → no seed, no draft peek.
  if (ver && Array.isArray((ver as any).snapshot)) {
    const snap = (ver as any).snapshot as SnapshotChecklistTopic[];
    const hit = snap.find((t) => t.topicId === topicId);
    if (!hit) return null;
    return {
      topicId: hit.topicId,
      displayLabel: hit.displayLabel,
      vitanaVoiceScript: hit.vitanaVoiceScript ?? null,
      explanation: hit.explanation,
      guidedPracticeTarget: hit.guidedPracticeTarget ?? null,
      source: 'published',
    };
  }

  // Bootstrap fallback: nothing published yet → read the live draft row.
  const draft = await getTopic(client, topicId);
  if (!draft || !draft.enabled || draft.status === 'disabled') return null;
  return {
    topicId: draft.topicId,
    displayLabel: draft.displayLabel,
    vitanaVoiceScript: draft.vitanaVoiceScript,
    explanation: draft.explanation,
    guidedPracticeTarget: draft.guidedPracticeTarget,
    source: 'draft_fallback',
  };
}
