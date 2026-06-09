/**
 * VTID-03277 — Guided Journey checklist publish + rollback (P2).
 *
 * publish: validate the working draft → if ok, snapshot it into an immutable
 *   journey_checklist_versions row marked is_current=true (the single version
 *   My Journey serves), unsetting the previous current. Blocked if invalid.
 * rollback: flip is_current to a prior published version (non-destructive — the
 *   working draft is untouched; My Journey simply serves the older snapshot).
 *
 * Both write an audit row.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChecklistValidationResult, ChecklistVersion } from '../../types/journey-checklist';
import { listTopics, toSnapshotTopic } from './checklist-service';
import { validateChecklist } from './checklist-validator';

const V = 'journey_checklist_versions';
const A = 'journey_checklist_audit';

export class ChecklistValidationError extends Error {
  result: ChecklistValidationResult;
  constructor(result: ChecklistValidationResult) {
    super('checklist validation failed');
    this.name = 'ChecklistValidationError';
    this.result = result;
  }
}

function rowToVersion(r: any): ChecklistVersion {
  return {
    id: r.id,
    versionLabel: r.version_label,
    curriculumVersion: r.curriculum_version,
    status: r.status,
    sessionCount: r.session_count,
    topicCount: r.topic_count,
    isCurrent: r.is_current,
    note: r.note ?? null,
    publishedBy: r.published_by ?? null,
    publishedAt: r.published_at,
  };
}

export async function listVersions(
  client: SupabaseClient,
  curriculumVersion = 'v2',
): Promise<ChecklistVersion[]> {
  const { data, error } = await client
    .from(V)
    .select('id, version_label, curriculum_version, status, session_count, topic_count, is_current, note, published_by, published_at')
    .eq('curriculum_version', curriculumVersion)
    .order('published_at', { ascending: false });
  if (error) throw error;
  return (data as any[]).map(rowToVersion);
}

/**
 * Validate + publish the working draft as a new current version.
 * @throws ChecklistValidationError when the draft is not publishable.
 */
export async function publishChecklist(
  client: SupabaseClient,
  adminId: string,
  opts: { curriculumVersion?: string; note?: string; now?: string } = {},
): Promise<{ version: ChecklistVersion; validation: ChecklistValidationResult }> {
  const curriculumVersion = opts.curriculumVersion ?? 'v2';
  const now = opts.now ?? new Date().toISOString();

  const topics = await listTopics(client, { curriculumVersion });
  const validation = validateChecklist(topics);
  if (!validation.ok) throw new ChecklistValidationError(validation);

  const active = topics.filter((t) => t.enabled && t.status !== 'disabled');
  // VTID-03289: snapshot the voice-inclusive shape so the ORB seam can narrate
  // the published topic. The public HTTP read re-strips vitanaVoiceScript.
  const snapshot = active.map(toSnapshotTopic);
  const versionLabel = `${curriculumVersion}-${now}`;

  // Unset previous current for this curriculum line, then insert the new one.
  const unset = await client
    .from(V)
    .update({ is_current: false })
    .eq('curriculum_version', curriculumVersion)
    .eq('is_current', true);
  if (unset.error) throw unset.error;

  const inserted = await client
    .from(V)
    .insert({
      version_label: versionLabel,
      curriculum_version: curriculumVersion,
      status: 'published',
      session_count: validation.summary.sessionCount,
      topic_count: validation.summary.topicCount,
      snapshot,
      validation,
      is_current: true,
      note: opts.note ?? null,
      published_by: adminId,
      published_at: now,
    })
    .select('id, version_label, curriculum_version, status, session_count, topic_count, is_current, note, published_by, published_at')
    .single();
  if (inserted.error) throw inserted.error;

  const version = rowToVersion(inserted.data);
  await client.from(A).insert({
    actor_admin_id: adminId,
    action: 'publish',
    version_id: version.id,
    detail: `Published ${version.topicCount} topics across ${version.sessionCount} sessions`,
  });
  return { version, validation };
}

/** Make a prior published version current again (non-destructive). */
export async function rollbackChecklist(
  client: SupabaseClient,
  adminId: string,
  versionId: string,
  opts: { curriculumVersion?: string } = {},
): Promise<ChecklistVersion> {
  const curriculumVersion = opts.curriculumVersion ?? 'v2';

  const target = await client
    .from(V)
    .select('id, curriculum_version')
    .eq('id', versionId)
    .maybeSingle();
  if (target.error) throw target.error;
  if (!target.data) throw new Error('version_not_found');

  const unset = await client
    .from(V)
    .update({ is_current: false })
    .eq('curriculum_version', curriculumVersion)
    .eq('is_current', true);
  if (unset.error) throw unset.error;

  const updated = await client
    .from(V)
    .update({ is_current: true, status: 'published' })
    .eq('id', versionId)
    .select('id, version_label, curriculum_version, status, session_count, topic_count, is_current, note, published_by, published_at')
    .single();
  if (updated.error) throw updated.error;

  await client.from(A).insert({
    actor_admin_id: adminId,
    action: 'rollback',
    version_id: versionId,
    detail: `Rolled current pointer back to version ${versionId}`,
  });
  return rowToVersion(updated.data);
}
