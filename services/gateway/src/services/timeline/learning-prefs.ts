/**
 * VTID-05171 — Life Timeline P5: "Vitana may learn from this" switches.
 *
 * One row per (member, category) in public.timeline_learning_prefs; a missing
 * row means on (owner default D2). `app_usage` is the "learn from my app
 * usage" switch: off stops the habit rollup and deletes the app-usage
 * routines it wrote. A pillar category switched off stops the profiler and
 * the rollup from using that pillar's moments (health data stays governed by
 * the existing health consent and sensitivity rules as well).
 *
 * Before the VTID-05171 migration is applied the table does not exist: every
 * reader then answers "all on" (today's behaviour) and the writer reports
 * `unavailable` so the route can answer 409 instead of pretending.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingSchema } from './timeline-repository';

export const LEARNABLE_CATEGORIES = [
  'nutrition', 'hydration', 'exercise', 'sleep', 'mental', 'cross_pillar',
  'diary', 'goals', 'journey', 'vitana', 'community', 'events', 'live_media',
  'shop', 'wallet', 'account', 'app_usage',
] as const;
export type LearnableCategory = (typeof LEARNABLE_CATEGORIES)[number];

/** Routine kinds the habit rollup derives from app usage (D2: deleted when app_usage is off). */
export const APP_USAGE_ROUTINE_KINDS = ['screen_habit', 'active_hours', 'feature_affinity'] as const;
export const PILLAR_RHYTHM_KIND = 'pillar_rhythm';

export interface LearningPrefs {
  /** Categories the member switched off. */
  off: Set<string>;
  /** false when the member switched off "learn from my app usage". */
  appUsage: boolean;
  /** false before the migration (table missing) — everything counts as on. */
  available: boolean;
}

export const ALL_ON: LearningPrefs = { off: new Set(), appUsage: true, available: false };

export function isLearnableCategory(v: unknown): v is LearnableCategory {
  return typeof v === 'string' && (LEARNABLE_CATEGORIES as readonly string[]).includes(v);
}

export function prefsFromRows(rows: Array<{ category: string; learn: boolean }>, available = true): LearningPrefs {
  const off = new Set(rows.filter((r) => r.learn === false).map((r) => r.category));
  return { off, appUsage: !off.has('app_usage'), available };
}

export async function fetchLearningPrefs(sb: SupabaseClient, userId: string): Promise<LearningPrefs> {
  const { data, error } = await sb.from('timeline_learning_prefs').select('category, learn').eq('user_id', userId);
  if (error) {
    if (!isMissingSchema(error)) console.warn('[VTID-05171] timeline_learning_prefs read failed:', error.message);
    return ALL_ON;
  }
  return prefsFromRows((data ?? []) as Array<{ category: string; learn: boolean }>);
}

/** Many members at once (rollup). Missing table → empty map (all on). */
export async function fetchLearningPrefsFor(sb: SupabaseClient, userIds: string[]): Promise<Map<string, LearningPrefs>> {
  const out = new Map<string, LearningPrefs>();
  if (userIds.length === 0) return out;
  const { data, error } = await sb.from('timeline_learning_prefs').select('user_id, category, learn').in('user_id', userIds);
  if (error) {
    if (!isMissingSchema(error)) console.warn('[VTID-05171] timeline_learning_prefs bulk read failed:', error.message);
    return out;
  }
  const byUser = new Map<string, Array<{ category: string; learn: boolean }>>();
  for (const r of (data ?? []) as Array<{ user_id: string; category: string; learn: boolean }>) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id)!.push(r);
  }
  for (const [u, rows] of byUser) out.set(u, prefsFromRows(rows));
  return out;
}

export type SetPrefResult = { ok: true; routines_deleted: number } | { ok: false; reason: 'unavailable' | 'failed' };

/**
 * Upsert one switch. Switching `app_usage` off deletes the app-usage routines
 * (D2); switching a pillar off deletes that pillar's rhythm routine.
 */
export async function setLearningPref(
  sb: SupabaseClient,
  userId: string,
  category: LearnableCategory,
  learn: boolean,
): Promise<SetPrefResult> {
  const { error } = await sb
    .from('timeline_learning_prefs')
    .upsert({ user_id: userId, category, learn, updated_at: new Date().toISOString() }, { onConflict: 'user_id,category' });
  if (error) {
    if (isMissingSchema(error)) return { ok: false, reason: 'unavailable' };
    console.error('[VTID-05171] timeline_learning_prefs upsert failed:', error.message);
    return { ok: false, reason: 'failed' };
  }
  if (learn) return { ok: true, routines_deleted: 0 };

  let deleted = 0;
  if (category === 'app_usage') {
    const r = await sb.from('user_routines').delete({ count: 'exact' }).eq('user_id', userId).in('routine_kind', [...APP_USAGE_ROUTINE_KINDS]);
    if (r.error) console.error('[VTID-05171] app-usage routine delete failed:', r.error.message);
    else deleted += r.count ?? 0;
  } else {
    // The category's own routines: its affinity, and for a pillar its rhythm.
    const r = await sb
      .from('user_routines')
      .delete({ count: 'exact' })
      .eq('user_id', userId)
      .in('routine_kind', ['feature_affinity', PILLAR_RHYTHM_KIND])
      .eq('routine_key', category);
    if (r.error) console.error('[VTID-05171] category routine delete failed:', r.error.message);
    else deleted += r.count ?? 0;
  }
  return { ok: true, routines_deleted: deleted };
}
