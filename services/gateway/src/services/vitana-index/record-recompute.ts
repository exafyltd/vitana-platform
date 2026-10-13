/**
 * VTID-05168 — Life Timeline P2: every Vitana Index recompute goes through
 * `vitana_index_recompute_and_record()` (per-member advisory lock → before →
 * canonical compute → after → movement row when something changed). The
 * movement is what lets the timeline show "+6 Exercise" for the entry that
 * caused it, and never a number nobody measured.
 *
 * Callers pass WHY they recompute (`trigger`) and WHAT caused it
 * (`sourceKind`/`sourceRef`). The result keeps the canonical compute's shape
 * (score_total, score_<pillar>, subscores, balance_factor, …) plus
 * `movement_id`, `delta_total`, `per_pillar_delta`, `prior_score_total`.
 *
 * Rollout: the migration (20261014140000_vtid_05168_index_movements.sql) is
 * applied after Gate 2, and staging runs against the shared database. Until
 * the recording function exists, PostgREST answers "function not found" and
 * this helper falls back to `health_compute_vitana_index_for_user` — the
 * exact call every site made before — so the gateway is correct in either
 * order. Any other error is returned as-is (never silently retried).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const INDEX_RECOMPUTE_TRIGGERS = [
  'voice_log',
  'manual_log',
  'diary',
  'wearable_sync',
  'calendar_completion',
  'baseline_survey',
  'self_heal',
] as const;
export type IndexRecomputeTrigger = (typeof INDEX_RECOMPUTE_TRIGGERS)[number];

export interface IndexRecomputeInput {
  userId: string;
  date: string;
  trigger: IndexRecomputeTrigger;
  sourceKind?: string | null;
  sourceRef?: string | null;
  modelVersion?: string;
}

export const RECORDING_RPC = 'vitana_index_recompute_and_record';
export const LEGACY_RPC = 'health_compute_vitana_index_for_user';

function isMissingRecordingFunction(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === 'PGRST202' || err.code === '42883') return true;
  const msg = String(err.message || '');
  return msg.includes(RECORDING_RPC) && /could not find the function|does not exist/i.test(msg);
}

export async function recordIndexRecompute(
  sb: SupabaseClient,
  input: IndexRecomputeInput,
): Promise<{ data: Record<string, any> | null; error: { code?: string; message: string } | null }> {
  const modelVersion = input.modelVersion ?? 'v3-5pillar';
  const res = await sb.rpc(RECORDING_RPC, {
    p_user_id: input.userId,
    p_date: input.date,
    p_trigger: input.trigger,
    p_source_kind: input.sourceKind ?? null,
    p_source_ref: input.sourceRef ?? null,
    p_model_version: modelVersion,
  });
  if (!isMissingRecordingFunction(res?.error)) {
    return { data: (res?.data as Record<string, any> | null) ?? null, error: res?.error ?? null };
  }
  const legacy = await sb.rpc(LEGACY_RPC, { p_user_id: input.userId, p_date: input.date, p_model_version: modelVersion });
  return { data: (legacy?.data as Record<string, any> | null) ?? null, error: legacy?.error ?? null };
}
