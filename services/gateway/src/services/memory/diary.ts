/**
 * VTID-04390: one write path for diary entries.
 *
 * The app had five diary writers, each inserting into `diary_entries`
 * straight from the browser with its own tags and follow-ups
 * (TextDiaryEditor, PhotoDiaryUploader, VoiceDiaryRecorder,
 * UnifiedCaptureCard, useKnowledgeBase → AddMemoryDialog). Some called the
 * Vitana Index sync, some did not; none reached `memory_items`, so recall and
 * the Memory Garden never saw a diary entry.
 *
 * saveDiaryEntry() does all of it once, server side:
 *   1. `diary_entries` row (the Diary screen and its realtime channel keep
 *      reading this table);
 *   2. one `memory_items` episode (source 'diary', kind 'diary', linked by
 *      `content_json.diary_entry_id`), embedded on write, personal role;
 *   3. health features → Vitana Index recompute, with the per-pillar delta
 *      (the former /memory/diary/sync-index body, now syncDiaryToIndex()).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { extractHealthFeaturesFromDiary, persistDiaryHealthFeatures } from '../diary-health-extractor';
import * as memoryRepo from '../../routes/memory-repository';
import { writeMemoryItemWithIdentity } from '../orb-memory-bridge';
import { GARDEN_CATEGORIES } from './garden';

export const DIARY_SOURCES = ['text', 'voice', 'photo', 'manual'] as const;
export type DiarySource = (typeof DIARY_SOURCES)[number];
export const MAX_DIARY_CHARS = 10_000;
const NIL_TENANT = '00000000-0000-0000-0000-000000000000';

export interface DiaryEntryInput {
  text: string;
  source: DiarySource;
  tags?: string[];
  duration?: number | null;
  attachments?: unknown[] | null;
  entry_date?: string;
}

export interface DiaryIndexSync {
  entry_date: string;
  health_features_written: number;
  pillars_after: Record<string, number> | null;
  index_delta: Record<string, number> | null;
  streak?: unknown;
}

export interface SaveDiaryResult {
  ok: boolean;
  error?: string;
  status?: number;
  entry?: { id: string; created_at: string };
  memory_item_id?: string | null;
  index?: DiaryIndexSync | null;
}

/** The memory_items category for a diary entry: the first Garden category among its tags. */
export function diaryCategoryFromTags(tags: string[] | undefined): string {
  for (const raw of tags || []) {
    const t = String(raw).trim().toLowerCase().replace(/-/g, '_');
    if ((GARDEN_CATEGORIES as readonly string[]).includes(t) && t !== 'uncategorized') return t;
  }
  return 'notes';
}

export function normalizeDiaryInput(body: any): { ok: true; input: DiaryEntryInput } | { ok: false; error: string } {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const source = body?.source;
  if (!(DIARY_SOURCES as readonly string[]).includes(source)) return { ok: false, error: 'INVALID_SOURCE' };
  const attachments = Array.isArray(body?.attachments) ? body.attachments.slice(0, 20) : null;
  if (!text && !(attachments && attachments.length)) return { ok: false, error: 'EMPTY_ENTRY' };
  if (text.length > MAX_DIARY_CHARS) return { ok: false, error: 'TOO_LONG' };
  const tags = Array.isArray(body?.tags)
    ? body.tags.filter((t: unknown) => typeof t === 'string' && t.length <= 64).slice(0, 20)
    : [];
  const duration = typeof body?.duration === 'number' && Number.isFinite(body.duration) ? Math.max(0, Math.round(body.duration)) : null;
  const entry_date = typeof body?.entry_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.entry_date) ? body.entry_date : undefined;
  return { ok: true, input: { text, source, tags, duration, attachments, entry_date } };
}

/** Health features from the diary text → Vitana Index recompute + delta. */
export async function syncDiaryToIndex(
  admin: SupabaseClient,
  userId: string,
  tenantId: string,
  rawText: string,
  entryDate: string,
): Promise<DiaryIndexSync> {
  const { data: beforeRow } = await memoryRepo.fetchVitanaIndexScoreRow(admin, userId, entryDate);
  const before = beforeRow as Record<string, number> | null;

  const writes = extractHealthFeaturesFromDiary(rawText);
  let health_features_written = 0;
  if (writes.length > 0) {
    const { written } = await persistDiaryHealthFeatures(admin, userId, tenantId, entryDate, writes);
    health_features_written = written;
  }

  let pillars_after: Record<string, number> | null = null;
  try {
    const { data: rec } = await memoryRepo.recomputeVitanaIndexForUser(admin, userId, entryDate);
    const r = rec as any;
    if (r && r.ok !== false) {
      pillars_after = {
        total: Number(r.score_total ?? 0),
        nutrition: Number(r.score_nutrition ?? 0),
        hydration: Number(r.score_hydration ?? 0),
        exercise: Number(r.score_exercise ?? 0),
        sleep: Number(r.score_sleep ?? 0),
        mental: Number(r.score_mental ?? 0),
      };
    }
  } catch (recErr: any) {
    console.warn(`[VTID-01983] Index recompute failed (non-fatal): ${recErr?.message ?? recErr}`);
  }

  const index_delta = pillars_after
    ? {
        total: pillars_after.total - Number(before?.score_total ?? 0),
        nutrition: pillars_after.nutrition - Number(before?.score_nutrition ?? 0),
        hydration: pillars_after.hydration - Number(before?.score_hydration ?? 0),
        exercise: pillars_after.exercise - Number(before?.score_exercise ?? 0),
        sleep: pillars_after.sleep - Number(before?.score_sleep ?? 0),
        mental: pillars_after.mental - Number(before?.score_mental ?? 0),
      }
    : null;

  let streak: unknown;
  try {
    const { celebrateDiaryStreak } = await import('../diary-streak-celebrator');
    streak = await celebrateDiaryStreak(admin, userId, tenantId);
  } catch {
    streak = undefined;
  }
  return { entry_date: entryDate, health_features_written, pillars_after, index_delta, streak };
}

export async function resolveTenantId(admin: SupabaseClient, userId: string, jwtTenant?: string | null): Promise<string> {
  if (jwtTenant) return jwtTenant;
  const { data } = await memoryRepo.fetchUserTenantId(admin, userId);
  return (data?.tenant_id as string | undefined) ?? NIL_TENANT;
}

/** Save one diary entry through every step. Never throws. */
export async function saveDiaryEntry(
  admin: SupabaseClient,
  identity: { user_id: string; tenant_id: string },
  input: DiaryEntryInput,
): Promise<SaveDiaryResult> {
  const entryDate = input.entry_date ?? new Date().toISOString().slice(0, 10);
  const tags = input.tags && input.tags.length ? input.tags : ['diary', input.source];

  const { data: row, error } = await admin
    .from('diary_entries')
    .insert({
      user_id: identity.user_id,
      text: input.text || '',
      source: input.source,
      tags,
      duration: input.duration ?? null,
      attachments: input.attachments && input.attachments.length ? input.attachments : null,
    })
    .select('id, created_at')
    .single();
  if (error || !row) return { ok: false, status: 502, error: error?.message ?? 'INSERT_FAILED' };
  const entry = row as { id: string; created_at: string };

  let memoryItemId: string | null = null;
  if (input.text) {
    try {
      const written = await writeMemoryItemWithIdentity(
        { tenant_id: identity.tenant_id, user_id: identity.user_id, active_role: null },
        {
          source: 'diary',
          content: input.text,
          category_key: diaryCategoryFromTags(tags),
          // <= 50: trg_notify_memory_garden notifies above 50 (VTID-04390).
          importance: 50,
          occurred_at: entry.created_at,
          skipFiltering: true,
          content_json: { kind: 'diary', diary_entry_id: entry.id, diary_source: input.source, tags },
        },
      );
      memoryItemId = written.ok ? written.id ?? null : null;
      if (!written.ok) console.warn(`[VTID-04390] diary episode write failed: ${written.error}`);
    } catch (err: any) {
      console.warn(`[VTID-04390] diary episode write threw: ${err?.message ?? err}`);
    }
  }

  let index: DiaryIndexSync | null = null;
  if (input.text) {
    try {
      index = await syncDiaryToIndex(admin, identity.user_id, identity.tenant_id, input.text, entryDate);
    } catch (err: any) {
      console.warn(`[VTID-04390] diary index sync failed (non-fatal): ${err?.message ?? err}`);
    }
  }
  return { ok: true, entry, memory_item_id: memoryItemId, index };
}

/** Delete a diary entry and its memory episode. */
export async function deleteDiaryEntry(
  admin: SupabaseClient,
  identity: { user_id: string; tenant_id: string },
  id: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const { data, error } = await admin.from('diary_entries').delete().eq('id', id).eq('user_id', identity.user_id).select('id');
  if (error) return { ok: false, status: 502, error: error.message };
  if (!data || (data as any[]).length === 0) return { ok: false, status: 404, error: 'NOT_FOUND' };
  await admin
    .from('memory_items')
    .delete()
    .eq('user_id', identity.user_id)
    .eq('tenant_id', identity.tenant_id)
    .eq('content_json->>diary_entry_id', id);
  return { ok: true };
}
