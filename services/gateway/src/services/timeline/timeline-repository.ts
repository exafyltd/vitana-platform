/**
 * VTID-05169 — Life Timeline P3: every database read/write of the timeline API.
 * Always filtered by the caller's user_id (service client), never by a value
 * from the request body.
 *
 * Rollout: the VTID-05167 columns (tier, pillar, category, …) and the
 * VTID-05168 movements table exist only after their migrations are applied
 * (Gate 2). Until then the column-aware queries answer "column does not
 * exist"; `isMissingSchema` lets the reader fall back to classifying rows in
 * process from the same catalog, so the API is correct in either order.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ActivityRow {
  id: string;
  activity_type: string;
  activity_data: Record<string, unknown> | null;
  created_at: string;
  tier?: string | null;
  pillar?: string | null;
  secondary_pillar?: string | null;
  category?: string | null;
  topic?: string | null;
  hidden_from_ai?: boolean | null;
}

export interface MovementRow {
  id: string;
  at: string;
  score_date: string;
  trigger: string;
  source_kind: string | null;
  source_ref: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  delta_total: number;
  delta_pillars: Record<string, number>;
  balance_before: number | null;
  balance_after: number | null;
}

export interface ScoreRow {
  date: string;
  score_total: number;
  score_nutrition: number;
  score_hydration: number;
  score_exercise: number;
  score_sleep: number;
  score_mental: number;
  feature_inputs?: { balance_factor?: number | string } | null;
}

type Err = { code?: string; message?: string } | null | undefined;

export function isMissingSchema(err: Err): boolean {
  if (!err) return false;
  if (err.code === '42703' || err.code === '42P01' || err.code === 'PGRST204' || err.code === 'PGRST205') return true;
  return /column .* does not exist|relation .* does not exist|could not find the table/i.test(String(err.message || ''));
}

const CLASSIFIED_COLS =
  'id, activity_type, activity_data, created_at, tier, pillar, secondary_pillar, category, topic, hidden_from_ai';
const LEGACY_COLS = 'id, activity_type, activity_data, created_at';

export interface ListQuery {
  userId: string;
  tiers: string[];
  before?: string | null;
  from?: string | null;
  to?: string | null;
  pillar?: string | null;
  category?: string | null;
  q?: string | null;
  limit: number;
}

/** Classified rows (after VTID-05167). Returns { missingSchema: true } before the migration. */
export async function fetchClassifiedRows(sb: SupabaseClient, q: ListQuery) {
  let query = sb.from('user_activity_log').select(CLASSIFIED_COLS).eq('user_id', q.userId).in('tier', q.tiers);
  if (q.before) query = query.lt('created_at', q.before);
  if (q.from) query = query.gte('created_at', q.from);
  if (q.to) query = query.lte('created_at', q.to);
  if (q.pillar) query = query.or(`pillar.eq.${q.pillar},secondary_pillar.eq.${q.pillar}`);
  if (q.category) query = query.eq('category', q.category);
  if (q.q) {
    const term = q.q.replace(/[%,()*]/g, ' ').trim();
    if (term) query = query.or(`topic.ilike.*${term}*,category.ilike.*${term}*,activity_type.ilike.*${term}*`);
  }
  const res = await query.order('created_at', { ascending: false }).limit(q.limit);
  if (isMissingSchema(res.error)) return { rows: [] as ActivityRow[], missingSchema: true, error: null };
  return { rows: (res.data ?? []) as ActivityRow[], missingSchema: false, error: res.error ?? null };
}

/** Unclassified rows (before VTID-05167) — the reader classifies them in process. */
export async function fetchLegacyRows(sb: SupabaseClient, q: Pick<ListQuery, 'userId' | 'before' | 'from' | 'to' | 'limit'>) {
  let query = sb.from('user_activity_log').select(LEGACY_COLS).eq('user_id', q.userId);
  if (q.before) query = query.lt('created_at', q.before);
  if (q.from) query = query.gte('created_at', q.from);
  if (q.to) query = query.lte('created_at', q.to);
  const res = await query.order('created_at', { ascending: false }).limit(q.limit);
  return { rows: (res.data ?? []) as ActivityRow[], error: res.error ?? null };
}

export async function fetchRowById(sb: SupabaseClient, userId: string, id: string) {
  let res = await sb.from('user_activity_log').select(CLASSIFIED_COLS).eq('user_id', userId).eq('id', id).maybeSingle();
  if (isMissingSchema(res.error)) {
    res = await sb.from('user_activity_log').select(LEGACY_COLS).eq('user_id', userId).eq('id', id).maybeSingle();
  }
  return { row: (res.data ?? null) as ActivityRow | null, error: res.error ?? null };
}

export async function fetchMovementsByIds(sb: SupabaseClient, userId: string, ids: string[]) {
  if (ids.length === 0) return [] as MovementRow[];
  const res = await sb.from('vitana_index_movements').select('*').eq('user_id', userId).in('id', ids);
  return res.error ? ([] as MovementRow[]) : ((res.data ?? []) as MovementRow[]);
}

export async function fetchMovementsBetween(sb: SupabaseClient, userId: string, fromIso: string, toIso: string) {
  const res = await sb
    .from('vitana_index_movements')
    .select('*')
    .eq('user_id', userId)
    .gte('at', fromIso)
    .lte('at', toIso)
    .order('at', { ascending: false })
    .limit(500);
  return res.error ? ([] as MovementRow[]) : ((res.data ?? []) as MovementRow[]);
}

export async function fetchRecentScores(sb: SupabaseClient, userId: string, sinceDate: string) {
  const res = await sb
    .from('vitana_index_scores')
    .select('date, score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental, feature_inputs')
    .eq('user_id', userId)
    .gte('date', sinceDate)
    .order('date', { ascending: true });
  return res.error ? ([] as ScoreRow[]) : ((res.data ?? []) as ScoreRow[]);
}

export async function setHiddenFromAi(sb: SupabaseClient, userId: string, id: string, hidden: boolean) {
  const res = await sb
    .from('user_activity_log')
    .update({ hidden_from_ai: hidden, hidden_at: hidden ? new Date().toISOString() : null })
    .eq('user_id', userId)
    .eq('id', id)
    .select('id')
    .maybeSingle();
  return { found: !!res.data, missingSchema: isMissingSchema(res.error), error: res.error ?? null };
}

export async function deleteRow(sb: SupabaseClient, userId: string, id: string) {
  const res = await sb.from('user_activity_log').delete().eq('user_id', userId).eq('id', id).select('id').maybeSingle();
  return { found: !!res.data, error: res.error ?? null };
}

// VTID-05171 — the member's own usage data: the stored-but-never-shown rows
// (silent: screen visits, sign-ins…; system: technical traces).
export const USAGE_TIERS = ['silent', 'system'] as const;

export async function countUsageRows(sb: SupabaseClient, userId: string) {
  const res = await sb.from('user_activity_log').select('id', { count: 'exact', head: true }).eq('user_id', userId).in('tier', [...USAGE_TIERS]);
  if (isMissingSchema(res.error)) return { count: null, missingSchema: true, error: null };
  return { count: res.count ?? 0, missingSchema: false, error: res.error ?? null };
}

export async function fetchUsageRows(sb: SupabaseClient, userId: string, limit: number) {
  const res = await sb
    .from('user_activity_log')
    .select('activity_type, activity_data, created_at, tier, category')
    .eq('user_id', userId)
    .in('tier', [...USAGE_TIERS])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (isMissingSchema(res.error)) return { rows: [] as Array<Record<string, unknown>>, missingSchema: true, error: null };
  return { rows: (res.data ?? []) as Array<Record<string, unknown>>, missingSchema: false, error: res.error ?? null };
}

export async function deleteUsageRows(sb: SupabaseClient, userId: string) {
  const res = await sb.from('user_activity_log').delete({ count: 'exact' }).eq('user_id', userId).in('tier', [...USAGE_TIERS]);
  if (isMissingSchema(res.error)) return { deleted: 0, missingSchema: true, error: null };
  if (res.error) return { deleted: 0, missingSchema: false, error: res.error };
  // Rows the daily archive already moved (VTID-05167 archives silent/system after 180 days).
  const arch = await sb.from('user_activity_log_archive').delete({ count: 'exact' }).eq('user_id', userId).in('tier', [...USAGE_TIERS]);
  if (arch.error && !isMissingSchema(arch.error)) return { deleted: res.count ?? 0, missingSchema: false, error: arch.error };
  return { deleted: (res.count ?? 0) + (arch.error ? 0 : arch.count ?? 0), missingSchema: false, error: null };
}
