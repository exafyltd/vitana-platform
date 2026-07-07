/**
 * New-facts detector — the shared "what did Vitana learn about you?" query.
 * (BOOTSTRAP-MEMORY-DAILY-LEARNING, Phase 3)
 *
 * ONE detector feeds BOTH felt-learning surfaces so the user is never told
 * the same thing twice in a day:
 *
 *   1. The greeting path (6th greeting-ledger signal `facts_learned`) —
 *      gatherOverviewPayload calls detectNewFacts with the last-session
 *      cutoff; the ledger's existing delta machinery guards repeats.
 *   2. The AP-0907 daily notification — fires only for users who did NOT
 *      get the moment in a session today (checks the greeting ledger's
 *      `facts_learned.spoken_at` and its own `learning_surfaced_v1` stamp).
 *
 * Counts current (non-superseded) memory_facts rows extracted after the
 * cutoff. The cutoff is clamped to LOOKBACK_CAP_MS so a returning user
 * isn't greeted with weeks of accumulated "news".
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const SIGNAL_LEARNING_SURFACED = 'learning_surfaced_v1';

/** Never look further back than this, whatever the last-session cutoff says. */
export const LOOKBACK_CAP_MS = 7 * 24 * 3600 * 1000;

/** Fact keys that are learning plumbing, not felt learning — never surfaced. */
const EXCLUDED_FACT_KEYS = new Set(['preferred_language']);

const SAMPLE_LIMIT = 3;

export interface NewFactsResult {
  count: number;
  sample: Array<{ key: string; value: string }>;
}

export interface DetectNewFactsArgs {
  supabase: SupabaseClient;
  userId: string;
  tenantId?: string;
  /** Cutoff (ISO). Clamped to now - LOOKBACK_CAP_MS. */
  sinceIso: string;
  nowMs?: number;
}

/** Best-effort: any failure → zero result (surfaces stay silent, never wrong). */
export async function detectNewFacts(args: DetectNewFactsArgs): Promise<NewFactsResult> {
  const empty: NewFactsResult = { count: 0, sample: [] };
  if (!args.supabase || !args.userId || !args.sinceIso) return empty;
  const nowMs = args.nowMs ?? Date.now();
  const sinceMs = Date.parse(args.sinceIso);
  const clampedSinceIso = new Date(
    Math.max(Number.isFinite(sinceMs) ? sinceMs : 0, nowMs - LOOKBACK_CAP_MS),
  ).toISOString();
  try {
    let query = args.supabase
      .from('memory_facts')
      .select('fact_key, fact_value')
      .eq('user_id', args.userId)
      .is('superseded_at', null)
      .gt('extracted_at', clampedSinceIso)
      .order('extracted_at', { ascending: false })
      .limit(50);
    if (args.tenantId) query = query.eq('tenant_id', args.tenantId);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) return empty;
    const rows = (data as Array<{ fact_key?: unknown; fact_value?: unknown }>).filter(
      (r) => typeof r.fact_key === 'string' && !EXCLUDED_FACT_KEYS.has(r.fact_key),
    );
    return {
      count: rows.length,
      sample: rows.slice(0, SAMPLE_LIMIT).map((r) => ({
        key: String(r.fact_key),
        value: String(r.fact_value ?? '').slice(0, 80),
      })),
    };
  } catch {
    return empty;
  }
}

/** When was learning last surfaced to this user (via AP-0907)? Null = never/error. */
export async function readLearningSurfacedAt(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('user_assistant_state')
      .select('value')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .eq('signal_name', SIGNAL_LEARNING_SURFACED)
      .maybeSingle();
    if (error || !data) return null;
    const at = (data as { value?: { surfaced_at?: unknown } }).value?.surfaced_at;
    return typeof at === 'string' ? at : null;
  } catch {
    return null;
  }
}

/** Stamp that learning was surfaced (fire-and-forget, never throws). */
export async function markLearningSurfaced(
  supabase: SupabaseClient,
  tenantId: string,
  userId: string,
  count: number,
  nowIso?: string,
): Promise<void> {
  const at = nowIso ?? new Date().toISOString();
  try {
    await supabase.from('user_assistant_state').upsert(
      {
        tenant_id: tenantId,
        user_id: userId,
        signal_name: SIGNAL_LEARNING_SURFACED,
        value: { surfaced_at: at, count },
        last_seen_at: at,
      },
      { onConflict: 'tenant_id,user_id,signal_name' },
    );
  } catch {
    /* fire-and-forget */
  }
}
